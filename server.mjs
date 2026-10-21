import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLibrary, extensions, problem } from './lib/media.mjs';
import { createConversions } from './lib/conversions.mjs';

const execFileAsync = promisify(execFile);
export const root = path.dirname(fileURLToPath(import.meta.url));
const binary = name => path.join(root, 'bin', `${name}${process.platform === 'win32' ? '.exe' : ''}`);

async function pick(kind) {
  if (process.platform !== 'win32') throw problem('原生选择框仅支持 Windows，请粘贴文件路径。');
  const filter = [...extensions].map(ext => `*${ext}`).join(';');
  const code = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public sealed class PickerWindow : IDisposable {
  private readonly IntPtr owner;
  private readonly System.Threading.Timer timer;
  private readonly uint threadId;
  private delegate bool WindowCallback(IntPtr window, IntPtr unused);
  [DllImport("user32.dll")] private static extern bool EnumThreadWindows(uint thread, WindowCallback callback, IntPtr unused);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, System.Text.StringBuilder name, int count);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public PickerWindow(IntPtr owner) {
    this.owner = owner;
    uint process;
    threadId = GetWindowThreadProcessId(owner, out process);
    timer = new System.Threading.Timer(ActivateDialog, null, 100, 100);
  }
  public static IntPtr FindDialog(IntPtr owner, uint thread) {
    IntPtr found = IntPtr.Zero;
    EnumThreadWindows(thread, delegate(IntPtr window, IntPtr unused) {
      if (window == owner || !IsWindowVisible(window)) return true;
      var name = new System.Text.StringBuilder(64);
      GetClassName(window, name, name.Capacity);
      if (name.ToString() != "#32770") return true;
      for (IntPtr parent = GetWindow(window, 4); parent != IntPtr.Zero; parent = GetWindow(parent, 4)) {
        if (parent == owner) { found = window; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  private void ActivateDialog(object unused) {
    IntPtr popup = FindDialog(owner, threadId);
    if (popup == IntPtr.Zero) return;
    SetWindowPos(popup, new IntPtr(-1), 0, 0, 0, 0, 0x43);
    SetForegroundWindow(popup);
    Dispose();
  }
  public void Dispose() { timer.Dispose(); }
}
'@
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true
    $owner.ShowInTaskbar = $false
    $owner.FormBorderStyle = 'None'
    $owner.StartPosition = 'CenterScreen'
    $owner.Size = New-Object System.Drawing.Size(1, 1)
    $owner.Opacity = 0
    # A shown owner provides a real topmost HWND; an unshown Form does not.
    $owner.Show()
    $owner.Activate()
    # Shell dialogs do not reliably dispatch WinForms timer events.
    $activation = New-Object PickerWindow($owner.Handle)
    try {
    if ('${kind}' -eq 'folder') {
      $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
      $dialog.Description = '选择视频文件夹（包含所有子文件夹）'
      $dialog.ShowNewFolderButton = $false
      if ($dialog.ShowDialog($owner) -eq 'OK') { ConvertTo-Json -InputObject @($dialog.SelectedPath) -Compress }
      else { '[]' }
    } else {
      $dialog = New-Object System.Windows.Forms.OpenFileDialog
      $dialog.Title = '选择本地视频（可以多选）'
      $dialog.Filter = '视频文件|${filter}|所有文件|*.*'
      $dialog.Multiselect = $true
      if ($dialog.ShowDialog($owner) -eq 'OK') { ConvertTo-Json -InputObject @($dialog.FileNames) -Compress }
      else { '[]' }
    }
    } finally {
      $activation.Dispose()
      if ($dialog) { $dialog.Dispose() }
      $owner.Close()
      $owner.Dispose()
    }
  `;
  const { stdout } = await execFileAsync('powershell.exe',
    ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 300000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.trim() || '[]');
}

export async function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.LOCAL_VIDEO_DATA_DIR || path.join(root, 'data');
  const ffmpeg = options.ffmpeg || binary('ffmpeg');
  const ffprobe = options.ffprobe || binary('ffprobe');
  const library = createLibrary(dataDir, ffprobe);
  const conversions = await createConversions(path.join(dataDir, 'cache'), ffmpeg, library);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return res.status(403).json({ error: '仅允许本机访问。' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers.origin && req.headers.origin !== `http://${host}`) {
        return res.status(403).json({ error: '不允许跨站请求。' });
      }
      if (!req.is('application/json')) return res.status(415).json({ error: '请使用 JSON 请求。' });
    }
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'");
    next();
  });
  app.use(express.json({ limit: '128kb' }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.get('/api/health', async (req, res) => {
    const tools = await Promise.all([ffmpeg, ffprobe].map(p => access(p).then(() => true, () => false)));
    res.json({ app: 'local-video-player', version: '1.0.0', toolsReady: tools.every(Boolean) });
  });
  app.post('/api/shutdown', (req, res) => {
    if (!app.locals.shutdown) throw problem('当前服务不支持远程退出。', 409);
    res.json({ ok: true });
    setImmediate(() => app.locals.shutdown());
  });
  app.get('/api/sources', (req, res) => res.json(library.sources()));
  app.post('/api/sources', async (req, res) => res.json(await library.addSources(req.body.paths)));
  app.delete('/api/sources/:id', (req, res) => { library.removeSource(req.params.id); res.json({ ok: true }); });
  app.post('/api/scan', async (req, res) => res.json(await library.scan()));
  let pickerOpen = false;
  app.post('/api/pick', async (req, res) => {
    if (!['folder', 'file'].includes(req.body.kind)) throw problem('请选择文件或文件夹。');
    if (options.allowDialogs === false) throw problem('当前会话未启用选择框。');
    if (pickerOpen) throw problem('文件选择框已经打开，请先完成选择。', 409);
    pickerOpen = true;
    try { res.json({ paths: await pick(req.body.kind) }); }
    finally { pickerOpen = false; }
  });

  app.get('/api/videos', (req, res) => res.json(library.list(req.query.history === '1', String(req.query.search || ''))));
  app.post('/api/videos/:id/progress', (req, res) => res.json(library.saveProgress(req.params.id, req.body)));
  app.post('/api/videos/:id/prepare', async (req, res) => {
    const { video, metadata } = await library.probe(req.params.id);
    let playback;
    if (await conversions.cached(video)) {
      playback = { status: 'ready', url: `/api/videos/${video.id}/stream?kind=cache` };
    } else if (metadata.direct && !req.body.forceConvert) {
      playback = { status: 'ready', url: `/api/videos/${video.id}/stream?kind=original` };
    } else {
      playback = await conversions.prepare(video, metadata);
    }
    res.json({ ...playback, video: library.get(video.id), metadata });
  });
  app.get('/api/videos/:id/stream', async (req, res, next) => {
    const video = await library.resolve(req.params.id);
    if (!['original', 'cache', undefined].includes(req.query.kind)) throw problem('播放类型无效。');
    const useCache = req.query.kind === 'cache';
    let filename = video.path;
    if (useCache) {
      if (!await conversions.cached(video)) throw problem('播放缓存不存在，请重新打开视频。', 404);
      filename = conversions.cachePath(video);
      res.type('mp4');
    } else {
      // Never serve a client-supplied filesystem path.
      const metadata = video.metadata ? JSON.parse(video.metadata) : null;
      if (metadata?.direct) res.type(metadata.mime);
    }
    res.sendFile(filename, { acceptRanges: true, cacheControl: false, lastModified: true }, error => {
      if (error && !res.headersSent && !req.destroyed) next(error);
    });
  });
  app.delete('/api/videos/:id', async (req, res) => {
    await conversions.cancelVideo(req.params.id);
    library.removeVideo(req.params.id);
    res.json({ ok: true });
  });
  app.get('/api/jobs', (req, res) => res.json(conversions.list()));
  app.get('/api/jobs/:id', (req, res) => res.json(conversions.get(req.params.id)));
  app.post('/api/jobs/:id/cancel', (req, res) => res.json(conversions.cancel(req.params.id)));
  app.get('/api/cache', async (req, res) => res.json(await conversions.usage()));
  app.delete('/api/cache', async (req, res) => res.json(await conversions.clear()));
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在。' }));

  app.get('/vendor/artplayer.js', (req, res) => res.sendFile(path.join(root, 'node_modules/artplayer/dist/artplayer.js')));
  app.use(express.static(path.join(root, 'public'), { etag: true, maxAge: 0 }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    if (error.headers) res.set(error.headers);
    res.status(status).json({ error: error.type === 'entity.parse.failed' ? '请求内容不是有效的 JSON。'
      : error.status ? error.message : '操作失败，请检查文件权限并查看服务日志。' });
  });
  return { app, library, conversions, async close() { await conversions.close(); library.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = await createApp();
  const port = Number(process.env.PORT || 8765);
  const server = service.app.listen(port, '127.0.0.1', () => console.log(`本地放映室已启动：http://127.0.0.1:${port}`));
  server.on('error', async error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。请使用“启动.cmd”打开已有服务。` : error);
    await service.close();
    process.exitCode = 1;
  });
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeAllConnections();
    await service.close();
    process.exit(0);
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  service.app.locals.shutdown = stop;
}
