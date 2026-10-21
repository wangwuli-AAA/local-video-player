import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const extensions = new Set('.mp4 .m4v .webm .ogv .ogg .mov .mkv .avi .wmv .flv .ts .mts .m2ts .mpg .mpeg .rm .rmvb .vob .3gp .asf'.split(' '));

export function problem(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function signature(video) {
  return createHash('sha256').update(`${video.path}\0${video.size}\0${video.mtime_ms}`).digest('hex');
}

export function createLibrary(dataDir, ffprobe) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'library.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE COLLATE NOCASE, type TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
      size INTEGER NOT NULL, mtime_ms REAL NOT NULL, missing INTEGER NOT NULL DEFAULT 0,
      metadata TEXT, position REAL NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0, last_watched INTEGER, progress_stamp REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS source_videos (
      source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
      video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
      PRIMARY KEY(source_id, video_id)
    );`);
  if (!db.prepare('PRAGMA table_info(videos)').all().some(column => column.name === 'progress_stamp')) {
    db.exec('ALTER TABLE videos ADD COLUMN progress_stamp REAL NOT NULL DEFAULT 0');
  }

  const get = id => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
    if (!video) throw problem('视频记录不存在。', 404);
    return video;
  };
  const sources = () => db.prepare('SELECT * FROM sources ORDER BY rowid DESC').all();

  function updateFile(video, info) {
    if (video.size !== info.size || video.mtime_ms !== info.mtimeMs) {
      db.prepare(`UPDATE videos SET size=?, mtime_ms=?, metadata=NULL, position=0,
        duration=0, completed=0, last_watched=NULL, progress_stamp=0, missing=0 WHERE id=?`)
        .run(info.size, info.mtimeMs, video.id);
    } else {
      db.prepare('UPDATE videos SET missing=0 WHERE id=?').run(video.id);
    }
    return get(video.id);
  }

  async function resolve(id) {
    const video = get(id);
    try {
      const info = await stat(video.path);
      if (!info.isFile()) throw problem('该路径已不是文件。');
      return updateFile(video, info);
    } catch (error) {
      db.prepare('UPDATE videos SET missing=1 WHERE id=?').run(id);
      throw problem(`无法读取视频，文件可能已移动或删除：${video.path}`, 404);
    }
  }

  async function register(filename, sourceId) {
    const canonical = await realpath(filename);
    const info = await stat(canonical);
    let video = db.prepare('SELECT * FROM videos WHERE path=?').get(canonical);
    if (!video) {
      const id = randomUUID();
      db.prepare('INSERT INTO videos(id,path,name,size,mtime_ms) VALUES(?,?,?,?,?)')
        .run(id, canonical, path.basename(canonical), info.size, info.mtimeMs);
      video = get(id);
    } else {
      video = updateFile(video, info);
    }
    db.prepare('INSERT OR IGNORE INTO source_videos VALUES(?,?)').run(sourceId, video.id);
  }

  let scanning = Promise.resolve();
  function scan(selected = sources()) {
    const work = scanning.then(async () => {
      let found = 0;
      const warnings = [];
      async function walk(filename, source) {
        try {
          const info = await stat(filename);
          if (info.isDirectory()) {
            const entries = await readdir(filename, { withFileTypes: true });
            for (const entry of entries) {
              // Do not follow junctions/symlinks when recursively scanning a folder.
              if (!entry.isSymbolicLink()) await walk(path.join(filename, entry.name), source);
            }
          } else if (info.isFile() && extensions.has(path.extname(filename).toLowerCase())) {
            await register(filename, source.id);
            found++;
          }
        } catch {
          warnings.push(`无法读取：${filename}`);
        }
      }
      for (const source of selected) await walk(source.path, source);
      for (const video of db.prepare('SELECT id FROM videos').all()) {
        try { await resolve(video.id); } catch { /* Missing files remain in the library. */ }
      }
      return { found, warnings };
    });
    scanning = work.catch(() => {});
    return work;
  }

  async function addSources(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== 'string' || !p.trim())) {
      throw problem('请提供文件或文件夹的完整路径。');
    }
    const added = [];
    for (let filename of paths) {
      filename = filename.trim().replace(/^"|"$/g, '');
      if (!path.isAbsolute(filename)) throw problem('请使用完整的本地路径。');
      let canonical, info;
      try { canonical = await realpath(filename); info = await stat(canonical); }
      catch { throw problem(`路径不存在或无法读取：${filename}`); }
      if (!info.isDirectory() && (!info.isFile() || !extensions.has(path.extname(canonical).toLowerCase()))) {
        throw problem(`请选择视频文件或文件夹：${filename}`);
      }
      db.prepare('INSERT OR IGNORE INTO sources VALUES(?,?,?)')
        .run(randomUUID(), canonical, info.isDirectory() ? 'folder' : 'file');
      added.push(db.prepare('SELECT * FROM sources WHERE path=?').get(canonical));
    }
    return scan(added);
  }

  const probing = new Map();
  async function probe(id) {
    const video = await resolve(id);
    const key = signature(video);
    if (video.metadata) return { video, metadata: JSON.parse(video.metadata) };
    if (!probing.has(key)) {
      const promise = (async () => {
        let stdout;
        try {
          ({ stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', video.path],
            { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }));
        } catch (error) {
          if (error.code === 'ENOENT') throw problem('未找到 ffprobe，请运行首次安装脚本。', 503);
          throw problem('无法识别这个视频，文件可能损坏或格式不受支持。', 422);
        }
        const info = JSON.parse(stdout);
        const stream = info.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
        if (!stream) throw problem('文件中没有可播放的视频轨道。', 422);
        const audio = info.streams.find(s => s.codec_type === 'audio');
        const ext = path.extname(video.path).toLowerCase();
        const directMp4 = ['.mp4', '.m4v', '.mov'].includes(ext) && stream.codec_name === 'h264'
          && ['yuv420p', 'yuvj420p'].includes(stream.pix_fmt) && (!audio || ['aac', 'mp3'].includes(audio.codec_name));
        const directWebm = ext === '.webm' && ['vp8', 'vp9', 'av1'].includes(stream.codec_name)
          && (!audio || ['opus', 'vorbis'].includes(audio.codec_name));
        const duration = Number(info.format?.duration || stream.duration || 0);
        const metadata = {
          duration: Number.isFinite(duration) ? duration : 0,
          videoCodec: stream.codec_name, audioCodec: audio?.codec_name || null,
          width: stream.width, height: stream.height,
          videoIndex: stream.index, audioIndex: audio?.index ?? null,
          direct: directMp4 || directWebm,
          mime: directWebm ? 'video/webm' : 'video/mp4'
        };
        if (signature(await resolve(id)) !== key) throw problem('文件在读取期间发生了变化，请重试。', 409);
        db.prepare('UPDATE videos SET metadata=?, duration=? WHERE id=?')
          .run(JSON.stringify(metadata), metadata.duration, id);
        return { video: get(id), metadata };
      })().finally(() => probing.delete(key));
      probing.set(key, promise);
    }
    return probing.get(key);
  }

  function saveProgress(id, body) {
    get(id);
    const { position, duration, completed = false, updatedAt = Date.now() } = body;
    if (!Number.isFinite(position) || position < 0 || !Number.isFinite(duration) || duration <= 0 || typeof completed !== 'boolean') {
      throw problem('播放进度无效。');
    }
    if (!Number.isFinite(updatedAt) || updatedAt < 0 || updatedAt > Date.now() + 60000) throw problem('进度时间无效。');
    db.prepare('UPDATE videos SET position=?,duration=?,completed=?,last_watched=?,progress_stamp=? WHERE id=? AND progress_stamp <= ?')
      .run(Math.min(position, duration), duration, Number(completed), Date.now(), updatedAt, id, updatedAt);
    return get(id);
  }

  return {
    db, get, sources, scan, addSources, resolve, probe, saveProgress,
    list(history = false, search = '') {
      const rows = db.prepare(`SELECT * FROM videos ${history ? 'WHERE last_watched IS NOT NULL' : ''}
        ORDER BY ${history ? 'last_watched DESC' : 'name COLLATE NOCASE, path'}`).all();
      return rows.filter(v => v.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
        .map(({ metadata, ...video }) => ({ ...video, directory: path.dirname(video.path) }));
    },
    removeVideo(id) { get(id); db.prepare('DELETE FROM videos WHERE id=?').run(id); },
    removeSource(id) {
      // Removing a source stops future scans; already imported videos and history stay intact.
      db.prepare('DELETE FROM sources WHERE id=?').run(id);
    },
    close() { db.close(); }
  };
}
