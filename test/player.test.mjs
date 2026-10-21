import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, stat, readdir, utimes, unlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import http from 'node:http';
import { createApp, root } from '../server.mjs';

const exec = promisify(execFile);
const ffmpeg = path.join(root, 'bin/ffmpeg.exe');
const ffprobe = path.join(root, 'bin/ffprobe.exe');
let sandbox, mediaDir, dataDir, service, server, base, mp4, mkv, avi;
async function start() {
  service = await createApp({ dataDir, ffmpeg, ffprobe, allowDialogs: false });
  server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
}
async function stop() {
  if (!service) return;
  server.close();
  server.closeAllConnections();
  await service.close();
  service = null;
}
async function request(url, method = 'GET', body, expected = 200) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const result = await res.json();
  assert.equal(res.status, expected, JSON.stringify(result));
  return result;
}
async function waitJob(id, status = ['completed', 'error', 'cancelled']) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const job = await request(`/api/jobs/${id}`);
    if (status.includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('Timed out waiting for conversion');
}
async function generate(filename, codec, duration = 2) {
  await exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', String(duration), '-c:v', codec, '-pix_fmt', 'yuv420p', '-c:a', codec === 'libx264' ? 'aac' : 'pcm_s16le', filename],
  { windowsHide: true, timeout: 60000 });
}

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'local-video-test-'));
  mediaDir = path.join(sandbox, '中文 视频');
  dataDir = path.join(sandbox, 'state');
  await mkdir(path.join(mediaDir, '多层目录'), { recursive: true });
  mp4 = path.join(mediaDir, '第一课 测试.mp4');
  mkv = path.join(mediaDir, '多层目录', '不兼容编码.mkv');
  avi = path.join(mediaDir, '旧视频.avi');
  await generate(mp4, 'libx264', 8);
  await generate(mkv, 'mpeg4');
  await generate(avi, 'mpeg4');
  await writeFile(path.join(mediaDir, '说明.txt'), 'not a video');
  await start();
});
after(async () => { await stop(); console.log(`Test artifacts: ${sandbox}`); });

test('local imports, playback, progress, conversions and persistence', async t => {
  let videos, direct, incompatible, legacy;
  await t.test('offline assets, local-only host/origin checks and tools', async () => {
    assert.equal((await request('/api/health')).toolsReady, true);
    for (const url of ['/', '/style.css', '/app.js', '/vendor/artplayer.js']) {
      const res = await fetch(base + url);
      assert.equal(res.status, 200);
      assert.ok((await res.text()).length > 50);
      assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    }
    const foreign = await fetch(base + '/api/scan', { method: 'POST', headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(foreign.status, 403);
    const badHostStatus = await new Promise((resolve, reject) => {
      const req = http.get(base + '/api/health', { headers: { host: 'foreign.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
    });
    assert.equal(badHostStatus, 403);
    const form = await fetch(base + '/api/sources', { method: 'POST', body: 'paths=bad' });
    assert.equal(form.status, 415);
  });
  await t.test('Chinese nested paths, single files, deduplication and search', async () => {
    assert.equal((await request('/api/sources', 'POST', { paths: [mediaDir] })).found, 3);
    await request('/api/sources', 'POST', { paths: [mp4, mediaDir] });
    videos = await request('/api/videos');
    assert.equal(videos.length, 3);
    direct = videos.find(v => v.path === mp4);
    incompatible = videos.find(v => v.path === mkv);
    legacy = videos.find(v => v.path === avi);
    assert.ok(direct && incompatible && legacy);
    assert.equal((await request('/api/videos?search=' + encodeURIComponent('第一课'))).length, 1);
    await request('/api/sources', 'POST', { paths: ['relative/path'] }, 400);
    await request('/api/sources', 'POST', { paths: [path.join(sandbox, 'missing')] }, 400);
  });
  await t.test('MP4 direct playback and Range including HEAD and invalid ranges', async () => {
    const playback = await request(`/api/videos/${direct.id}/prepare`, 'POST');
    assert.equal(playback.status, 'ready');
    assert.equal(playback.metadata.direct, true);
    const res = await fetch(base + playback.url, { headers: { Range: 'bytes=10-109' } });
    assert.equal(res.status, 206);
    assert.equal((await res.arrayBuffer()).byteLength, 100);
    assert.match(res.headers.get('content-range'), /^bytes 10-109\//);
    assert.match(res.headers.get('content-type'), /video\/mp4/);
    const head = await fetch(base + playback.url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), (await stat(mp4)).size);
    const invalid = await fetch(base + playback.url, { headers: { Range: 'bytes=999999999-' } });
    assert.equal(invalid.status, 416);
    assert.match(invalid.headers.get('content-range'), /^bytes \*\//);
    await request('/api/videos/not-registered/stream?path=' + encodeURIComponent(mp4), 'GET', undefined, 404);
  });
  await t.test('progress validation, stale writes, recent ordering, completion and service restart', async () => {
    await request(`/api/videos/${direct.id}/progress`, 'POST', { position: -1, duration: 8 }, 400);
    const stamp = Date.now();
    await request(`/api/videos/${direct.id}/progress`, 'POST', { position: 4.2, duration: 8, updatedAt: stamp });
    await request(`/api/videos/${direct.id}/progress`, 'POST', { position: 1, duration: 8, updatedAt: stamp - 1 });
    assert.equal(service.library.get(direct.id).position, 4.2);
    await request(`/api/videos/${incompatible.id}/progress`, 'POST', { position: 2, duration: 2, completed: true });
    const history = await request('/api/videos?history=1');
    assert.equal(history[0].id, incompatible.id);
    assert.equal(history[0].completed, 1);
    await stop();
    await start();
    const video = (await request(`/api/videos/${direct.id}/prepare`, 'POST')).video;
    assert.equal(video.position, 4.2);
    assert.equal((await request('/api/videos?history=1')).length, 2);
  });
  await t.test('actual MKV / AVI conversion, cache Range and reuse', async () => {
    for (const video of [incompatible, legacy]) {
      const result = await request(`/api/videos/${video.id}/prepare`, 'POST');
      assert.ok(result.id);
      assert.equal(result.metadata.direct, false);
      const finished = await waitJob(result.id);
      assert.equal(finished.status, 'completed', finished.error);
      assert.equal(finished.percent, 100);
      const playback = await request(`/api/videos/${video.id}/prepare`, 'POST');
      assert.equal(playback.status, 'ready');
      assert.match(playback.url, /kind=cache/);
      const range = await fetch(base + playback.url, { headers: { Range: 'bytes=0-127' } });
      assert.equal(range.status, 206);
      assert.equal((await range.arrayBuffer()).byteLength, 128);
      const cachedVideo = await service.library.resolve(video.id);
      const output = await exec(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', service.conversions.cachePath(cachedVideo)], { windowsHide: true });
      const streams = JSON.parse(output.stdout).streams;
      assert.equal(streams.find(s => s.codec_type === 'video').codec_name, 'h264');
      assert.equal(streams.find(s => s.codec_type === 'audio').codec_name, 'aac');
    }
    const usage = await request('/api/cache');
    assert.equal(usage.files, 2);
    assert.ok(usage.bytes > 0);
  });
  await t.test('source changes invalidate cached playback and reset old progress', async () => {
    const future = new Date(Date.now() + 3000);
    await utimes(mkv, future, future);
    await request(`/api/videos/${incompatible.id}/stream?kind=cache`, 'GET', undefined, 404);
    assert.equal(service.library.get(incompatible.id).completed, 0);
    const result = await request(`/api/videos/${incompatible.id}/prepare`, 'POST');
    assert.ok(result.id);
    assert.equal((await waitJob(result.id)).status, 'completed');
  });
  await t.test('single conversion worker, queue cancellation, active cancellation and retry', async () => {
    await request('/api/cache', 'DELETE');
    const longPath = path.join(mediaDir, '长视频 取消测试.avi');
    await generate(longPath, 'mpeg4', 60);
    await request('/api/sources', 'POST', { paths: [longPath] });
    const long = (await request('/api/videos')).find(v => v.path === longPath);
    const first = await request(`/api/videos/${long.id}/prepare`, 'POST');
    const second = await request(`/api/videos/${legacy.id}/prepare`, 'POST');
    assert.equal(second.status, 'queued');
    assert.equal((await request('/api/jobs')).filter(j => j.status === 'converting').length, 1);
    await request(`/api/jobs/${second.id}/cancel`, 'POST');
    assert.equal((await waitJob(second.id)).status, 'cancelled');
    await request(`/api/jobs/${first.id}/cancel`, 'POST');
    assert.equal((await waitJob(first.id)).status, 'cancelled');
    assert.equal((await readdir(path.join(dataDir, 'cache'))).filter(file => file.endsWith('.part.mp4')).length, 0);
    const retry = await request(`/api/videos/${legacy.id}/prepare`, 'POST');
    assert.equal((await waitJob(retry.id)).status, 'completed');
    // Clear must stop the worker and leave no partial or completed caches.
    await request(`/api/videos/${long.id}/prepare`, 'POST');
    await request('/api/cache', 'DELETE');
    assert.deepEqual(await request('/api/cache'), { bytes: 0, files: 0 });
    assert.equal((await request('/api/jobs')).length, 0);
    assert.equal((await stat(longPath)).size > 0, true);
  });
  await t.test('missing files, corrupt media, source removal and original preservation', async () => {
    const gone = path.join(sandbox, '即将移走.mp4');
    await copyFile(mp4, gone);
    await request('/api/sources', 'POST', { paths: [gone] });
    const video = (await request('/api/videos')).find(v => v.path === gone);
    await unlink(gone);
    await request('/api/scan', 'POST');
    assert.equal((await request('/api/videos')).find(v => v.id === video.id).missing, 1);
    await request(`/api/videos/${video.id}/prepare`, 'POST', {}, 404);
    const broken = path.join(sandbox, '损坏的视频.mkv');
    await writeFile(broken, 'not real video');
    await request('/api/sources', 'POST', { paths: [broken] });
    const corrupt = (await request('/api/videos')).find(v => v.path === broken);
    await request(`/api/videos/${corrupt.id}/prepare`, 'POST', {}, 422);
    await request(`/api/videos/${corrupt.id}`, 'DELETE');
    assert.equal((await stat(broken)).size > 0, true);
    const source = (await request('/api/sources')).find(s => s.path === mp4);
    await request(`/api/sources/${source.id}`, 'DELETE');
    assert.ok((await request('/api/videos')).find(v => v.id === direct.id));
    assert.equal((await stat(mp4)).size > 0, true);
  });
  await t.test('missing converter reports a recoverable task error', async () => {
    await stop();
    service = await createApp({ dataDir, ffmpeg: path.join(sandbox, 'no-ffmpeg.exe'), ffprobe, allowDialogs: false });
    server = service.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    const result = await request(`/api/videos/${legacy.id}/prepare`, 'POST');
    const job = await waitJob(result.id);
    assert.equal(job.status, 'error');
    assert.match(job.error, /未找到 FFmpeg/);
  });
  await t.test('startup removes only incomplete conversion files', async () => {
    await stop();
    const cache = path.join(dataDir, 'cache');
    await writeFile(path.join(cache, 'orphan.part.mp4'), 'partial');
    await writeFile(path.join(cache, 'keep.txt'), 'keep');
    await start();
    const files = await readdir(cache);
    assert.ok(!files.includes('orphan.part.mp4'));
    assert.ok(files.includes('keep.txt'));
  });
});
