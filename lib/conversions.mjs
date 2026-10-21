import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { problem, signature } from './media.mjs';

export async function createConversions(cacheDir, ffmpeg, library) {
  await mkdir(cacheDir, { recursive: true });
  for (const file of await readdir(cacheDir)) {
    if (file.endsWith('.part.mp4')) await unlink(path.join(cacheDir, file));
  }
  const jobs = new Map();
  let active = null;
  let closed = false;
  let clearing = false;
  const cachePath = video => path.join(cacheDir, `${signature(video)}.mp4`);
  const view = job => ({
    id: job.id, videoId: job.videoId, status: job.status, percent: job.percent,
    error: job.error, url: job.status === 'completed' ? `/api/videos/${job.videoId}/stream?kind=cache` : undefined
  });
  async function cached(video) {
    try { return (await stat(cachePath(video))).size > 0; } catch { return false; }
  }

  async function run(job) {
    job.status = 'converting';
    const temp = path.join(cacheDir, `${job.key}.part.mp4`);
    let stderr = '';
    try {
      if (signature(await library.resolve(job.videoId)) !== job.key) throw new Error('源文件已改变，请重新打开视频。');
      if (job.cancelled) throw new Error('cancelled');
      await new Promise((resolve, reject) => {
        const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', job.video.path,
          '-map', `0:${job.metadata.videoIndex}`];
        if (job.metadata.audioIndex !== null) args.push('-map', `0:${job.metadata.audioIndex}`);
        args.push('-sn', '-dn', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
          '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', temp);
        const child = spawn(ffmpeg, args, { windowsHide: true });
        job.process = child;
        let pending = '';
        child.stdout.on('data', chunk => {
          pending += chunk.toString();
          const lines = pending.split(/\r?\n/);
          pending = lines.pop();
          for (const line of lines) {
            if (line.startsWith('out_time_us=') && job.metadata.duration > 0) {
              const seconds = Number(line.slice(12)) / 1000000;
              if (Number.isFinite(seconds)) job.percent = Math.min(99, Math.max(0, seconds / job.metadata.duration * 100));
            }
          }
        });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr || `FFmpeg exited (${code})`)));
      });
      if (job.cancelled) throw new Error('cancelled');
      if (signature(await library.resolve(job.videoId)) !== job.key) throw new Error('源文件已改变，请重新打开视频。');
      await rename(temp, cachePath(job.video));
      job.status = 'completed';
      job.percent = 100;
    } catch (error) {
      if (!job.cancelled) {
        const message = stderr || error.message;
        job.error = error.code === 'ENOENT' ? '未找到 FFmpeg，请运行首次安装脚本。'
          : /No space|not enough space|ENOSPC|disk.*full/i.test(message) ? '磁盘空间不足，请清理转换缓存或磁盘后重试。'
          : message.includes('源文件已改变') ? error.message
          : '转换失败，请检查文件是否损坏、磁盘空间及写入权限。';
        console.error('Conversion failed:', message);
      }
      await unlink(temp).catch(() => {});
      job.status = job.cancelled ? 'cancelled' : 'error';
    } finally {
      job.process = null;
    }
  }

  function next() {
    if (active || closed || clearing) return;
    const job = [...jobs.values()].find(j => j.status === 'queued');
    if (!job) return;
    active = job;
    job.done = run(job).finally(() => { active = null; next(); });
  }

  function cancel(job) {
    if (!['queued', 'converting'].includes(job.status)) return;
    job.cancelled = true;
    if (job.process) job.process.kill();
    else if (job.status === 'queued') job.status = 'cancelled';
  }

  return {
    cached, cachePath,
    async prepare(video, metadata) {
      if (clearing) throw problem('正在清理缓存，请稍后重试。', 409);
      if (await cached(video)) return { status: 'ready', url: `/api/videos/${video.id}/stream?kind=cache` };
      const key = signature(video);
      let job = [...jobs.values()].find(j => j.key === key && ['queued', 'converting'].includes(j.status) && !j.cancelled);
      if (!job) {
        // Keep only the most recent finished attempt for each video.
        for (const [id, previous] of jobs) {
          if (previous.videoId === video.id && !['queued', 'converting'].includes(previous.status)) jobs.delete(id);
        }
        job = { id: randomUUID(), videoId: video.id, video, metadata, key, status: 'queued', percent: 0 };
        jobs.set(job.id, job);
        next();
      }
      return view(job);
    },
    get(id) {
      const job = jobs.get(id);
      if (!job) throw problem('转换任务不存在，程序重启后请重新打开视频。', 404);
      return view(job);
    },
    list() { return [...jobs.values()].reverse().map(view); },
    cancel(id) {
      const job = jobs.get(id);
      if (!job) throw problem('转换任务不存在。', 404);
      cancel(job);
      return view(job);
    },
    async cancelVideo(videoId) {
      const related = [...jobs.values()].filter(j => j.videoId === videoId);
      for (const job of related) cancel(job);
      await Promise.all(related.map(j => j.done));
    },
    async usage() {
      let bytes = 0, files = 0;
      for (const file of await readdir(cacheDir)) {
        if (!file.endsWith('.mp4')) continue;
        const info = await stat(path.join(cacheDir, file)).catch(() => null);
        if (info) { bytes += info.size; files++; }
      }
      return { bytes, files };
    },
    async clear() {
      if (clearing) throw problem('正在清理缓存。', 409);
      clearing = true;
      try {
        for (const job of jobs.values()) cancel(job);
        await active?.done;
        for (const file of await readdir(cacheDir)) {
          if (file.endsWith('.mp4')) await unlink(path.join(cacheDir, file));
        }
        jobs.clear();
        return { bytes: 0, files: 0 };
      } catch {
        throw problem('部分缓存正在使用或无法删除，请停止播放后重试。', 409);
      } finally {
        clearing = false;
        next();
      }
    },
    async close() {
      closed = true;
      for (const job of jobs.values()) cancel(job);
      await active?.done;
    }
  };
}
