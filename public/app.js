'use strict';

const $ = id => document.getElementById(id);
const state = { videos: [], sources: [], folder: null, expandedFolders: new Set(), knownRoots: new Set(), history: false, search: '', current: null, art: null, generation: 0, jobId: null, jobs: [], load: 0 };
let noticeTimer;
let lastStamp = 0;
let saving = Promise.resolve();
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
function toast(message, error = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 11000 : 5000);
}
async function api(url, method = 'GET', body) {
  const response = await fetch(url, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败，请重试。');
  return result;
}
function time(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const s = Math.floor(seconds);
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function bytes(value) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024).toFixed(1)} KB`;
}
const percent = video => video.completed ? 100 : video.duration ? Math.min(100, video.position / video.duration * 100) : 0;
function watched(video) {
  if (video.completed) return '已看完 · 可重新播放';
  if (video.last_watched) return `看到 ${time(video.position)}${video.duration ? ` / ${time(video.duration)}` : ''}`;
  return video.duration ? `${time(video.duration)} · 尚未观看` : '尚未观看';
}
function date(stamp) {
  return new Date(stamp).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
function action(text, className, handler) {
  const button = el('button', className, text);
  button.type = 'button';
  button.addEventListener('click', () => Promise.resolve().then(handler).catch(error => toast(error.message, true)));
  return button;
}
function progressTrack(value) {
  const track = el('div', 'progress-track');
  const fill = el('i');
  fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
  track.append(fill);
  return track;
}

const normalizePath = value => value.replace(/\\/g, '/').replace(/\/+$/, '');
const pathKey = value => normalizePath(value).toLowerCase();
const withinFolder = (directory, folder) => pathKey(directory) === pathKey(folder) || pathKey(directory).startsWith(pathKey(folder) + '/');
const folderName = value => normalizePath(value).split('/').pop() || value;

function updateFolderDisclosure(node) {
  const toggle = node.firstElementChild.firstElementChild;
  const select = toggle.nextElementSibling;
  const expanded = state.expandedFolders.has(select.dataset.directory);
  toggle.textContent = expanded ? '▾' : '▸';
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('aria-label', `${expanded ? '收起' : '展开'}文件夹 ${folderName(select.title)}`);
  node.lastElementChild.hidden = !expanded;
}

function revealCurrentVideo() {
  const tree = $('folder-tree');
  const current = [...tree.querySelectorAll('[data-video-id]')].find(button => button.dataset.videoId === state.current?.video.id);
  if (!current) return;
  for (let node = current.closest('.folder-node'); node; node = node.parentElement.closest('.folder-node')) {
    const select = node.firstElementChild.querySelector('[data-directory]');
    state.expandedFolders.add(select.dataset.directory);
    updateFolderDisclosure(node);
  }
  // Scroll only the sidebar's directory viewport, without moving the player/page.
  const viewport = tree.getBoundingClientRect();
  const row = current.getBoundingClientRect();
  if (row.top < viewport.top) tree.scrollTop += row.top - viewport.top;
  else if (row.bottom > viewport.bottom) tree.scrollTop += row.bottom - viewport.bottom;
}

function renderFolderTree() {
  // Merge overlapping sources so each imported video appears exactly once.
  const candidates = [...state.sources.filter(source => source.type === 'folder').map(source => source.path),
    ...state.videos.map(video => video.directory)].map(normalizePath).sort((a, b) => a.length - b.length);
  const roots = [];
  for (const directory of candidates) {
    if (!roots.some(root => withinFolder(directory, root.path))) {
      roots.push({ path: directory, folders: new Map(), videos: [], count: 0 });
    }
  }
  for (const video of state.videos) {
    let node = roots.find(root => withinFolder(video.directory, root.path));
    node.count++;
    const relative = normalizePath(video.directory).slice(node.path.length).split('/').filter(Boolean);
    for (const part of relative) {
      const key = part.toLowerCase();
      if (!node.folders.has(key)) node.folders.set(key, { path: `${node.path}/${part}`, folders: new Map(), videos: [], count: 0 });
      node = node.folders.get(key);
      node.count++;
    }
    node.videos.push(video);
  }
  let groupId = 0;
  function folderItem(node, root = false) {
    const key = pathKey(node.path);
    if (root && !state.knownRoots.has(key)) {
      state.knownRoots.add(key);
      state.expandedFolders.add(key);
    }
    const item = el('li', 'folder-node');
    const row = el('div', 'folder-row');
    const children = el('ul', 'folder-children');
    children.id = `folder-group-${++groupId}`;
    const toggle = action('', 'folder-toggle', () => {
      if (state.expandedFolders.has(key)) state.expandedFolders.delete(key);
      else state.expandedFolders.add(key);
      updateFolderDisclosure(item);
    });
    toggle.setAttribute('aria-controls', children.id);
    const select = action('', 'folder-select', () => {
      state.folder = node.path;
      state.history = false;
      state.expandedFolders.add(key);
      updateFolderDisclosure(item);
      render();
    });
    select.dataset.directory = key;
    select.title = node.path;
    select.append(el('span', 'folder-symbol', '▱'), el('span', 'folder-name', folderName(node.path)), el('span', 'folder-count', node.count));
    row.append(toggle, select);
    const folders = [...node.folders.values()].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }));
    children.append(...folders.map(child => folderItem(child)));
    for (const video of [...node.videos].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))) {
      const file = el('li', 'folder-file');
      const play = action('', 'tree-video', () => openVideo(video.id));
      play.dataset.videoId = video.id;
      play.title = video.missing ? `文件不存在或无法读取：${video.path}` : video.path;
      play.setAttribute('aria-label', `播放 ${video.name}`);
      play.classList.toggle('missing-label', !!video.missing);
      play.append(el('span', 'tree-play', '▷'), el('span', 'folder-name', video.name));
      file.append(play);
      children.append(file);
    }
    item.append(row, children);
    updateFolderDisclosure(item);
    return item;
  }
  const list = el('ul', 'folder-roots');
  list.append(...roots.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true })).map(node => folderItem(node, true)));
  $('folder-tree').replaceChildren(roots.length ? list : el('p', 'tree-empty', '添加视频后，目录会显示在这里。'));
  if (state.folder && ![...$('folder-tree').querySelectorAll('[data-directory]')].some(button => button.dataset.directory === pathKey(state.folder))) state.folder = null;
}

function render() {
  const history = state.videos.filter(video => video.last_watched).sort((a, b) => b.last_watched - a.last_watched);
  $('all-count').textContent = state.videos.length;
  $('history-count').textContent = history.length;
  const videos = (state.history ? history : state.videos).filter(video => (!state.folder || withinFolder(video.directory, state.folder))
    && video.name.toLocaleLowerCase().includes(state.search.toLocaleLowerCase()));
  $('list-title').textContent = state.history ? '最近观看' : state.folder ? folderName(state.folder) : '全部视频';
  $('list-title').title = state.folder || '';
  $('list-count').textContent = `${videos.length} 部`;
  $('page-title').replaceChildren(document.createTextNode(state.history ? '接着上次的故事' : '我的放映室'), el('span', 'title-dot', '.'));
  $('page-subtitle').textContent = state.history ? '每一次暂停，都为下一次开始留了位置。' : state.folder ? `当前文件夹：${state.folder}（包含子目录）` : '打开一段视频，接着上次的故事。';
  $('all-nav').classList.toggle('active', !state.history && !state.folder);
  $('history-nav').classList.toggle('active', state.history);
  for (const button of $('folder-tree').querySelectorAll('[data-directory]')) {
    const selected = !!state.folder && button.dataset.directory === pathKey(state.folder);
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  for (const button of $('folder-tree').querySelectorAll('[data-video-id]')) {
    const playing = button.dataset.videoId === state.current?.video.id;
    button.classList.toggle('is-playing', playing);
    if (playing) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
  $('empty-state').hidden = videos.length > 0;
  $('empty-add').hidden = !!state.search || state.history || !!state.folder;
  if (state.search) {
    $('empty-title').textContent = '没有找到匹配的视频';
    $('empty-description').textContent = '换个名称搜索，或刷新视频列表。';
  } else if (state.folder) {
    $('empty-title').textContent = '这个文件夹还没有视频';
    $('empty-description').textContent = '添加视频后刷新列表，或选择其他文件夹。';
  } else if (state.history) {
    $('empty-title').textContent = '还没有观看记录';
    $('empty-description').textContent = '播放一个视频后，会在这里保留观看进度。';
  } else {
    $('empty-title').textContent = '第一场放映，从这里开始';
    $('empty-description').textContent = '添加本地视频或文件夹，观看进度会替你记住。';
  }
  const cards = videos.map(video => {
    const card = el('article', `video-card${video.missing ? ' missing' : ''}${state.current?.video.id === video.id ? ' is-playing' : ''}`);
    const open = action('', 'video-open', () => openVideo(video.id));
    open.setAttribute('aria-label', `播放 ${video.name}`);
    const icon = el('span', 'video-icon');
    icon.append(el('span', '', '▶'));
    const copy = el('span', 'video-copy');
    const name = el('span', 'video-name', video.name);
    name.title = video.name;
    const directory = el('span', 'video-path', video.directory);
    directory.title = video.path;
    copy.append(name, directory);
    open.append(icon, copy);
    const meta = el('div', 'video-meta');
    meta.append(el('span', video.missing ? 'missing-label' : '', video.missing ? '文件不存在或无法读取' : watched(video)), el('span', '', bytes(video.size)));
    const footer = el('div', 'video-footer');
    footer.append(el('span', '', video.last_watched ? `上次观看 ${date(video.last_watched)}` : video.name.split('.').pop().toUpperCase() + ' / LOCAL FILE'),
      action('移除', 'remove-video', async () => {
        if (!confirm(`从列表移除“${video.name}”？\n原视频文件不会删除。仍在已添加文件夹内的视频，刷新后会重新出现。`)) return;
        if (state.current?.video.id === video.id) await closePlayer();
        await api(`/api/videos/${video.id}`, 'DELETE');
        await load();
      }));
    card.append(open, meta, progressTrack(percent(video)), footer);
    return card;
  });
  $('video-list').replaceChildren(...cards);
  const resume = history.find(video => !video.completed && !video.missing && video.position > 0 && (!state.folder || withinFolder(video.directory, state.folder)));
  $('continue-panel').hidden = !resume || !!state.current || state.history || !!state.search;
  if (resume) {
    $('continue-title').textContent = resume.name;
    $('continue-title').title = resume.path;
    $('continue-meta').textContent = watched(resume);
    $('continue-progress').style.width = `${percent(resume)}%`;
    $('continue-button').onclick = () => openVideo(resume.id).catch(error => toast(error.message, true));
  }
}
async function load() {
  const generation = ++state.load;
  const [videos, sources] = await Promise.all([api('/api/videos'), api('/api/sources')]);
  if (generation !== state.load) return;
  state.videos = videos;
  state.sources = sources;
  renderFolderTree();
  render();
  revealCurrentVideo();
}

function snapshot() {
  const current = state.current;
  if (!current?.saveReady || !state.art) return null;
  const duration = state.art.duration;
  const position = state.art.currentTime;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return null;
  const updatedAt = lastStamp = Math.max(Date.now(), lastStamp + 1);
  const body = { position, duration, completed: current.completed, updatedAt };
  current.video = { ...current.video, ...body, last_watched: updatedAt };
  const video = state.videos.find(video => video.id === current.video.id);
  if (video) Object.assign(video, body, { last_watched: updatedAt });
  return { id: current.video.id, body };
}
function saveProgress(beacon = false) {
  const data = snapshot();
  if (!data) return saving;
  render();
  const url = `/api/videos/${data.id}/progress`;
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([JSON.stringify(data.body)], { type: 'application/json' }));
    return saving;
  }
  saving = saving.catch(() => {}).then(() => api(url, 'POST', data.body)).catch(error => toast(`进度未保存：${error.message}`, true));
  return saving;
}
function dispose() {
  if (state.art) {
    if (state.current) state.current.saveReady = false;
    state.art.destroy();
    state.art = null;
  }
  $('player').replaceChildren();
  $('player').hidden = true;
  $('restart-button').hidden = true;
  $('convert-button').hidden = true;
  $('cancel-button').hidden = true;
}
function setRightExpanded(expanded) {
  $('player-section').classList.toggle('right-expanded', expanded);
  document.body.classList.toggle('right-player-open', expanded);
  $('expand-player').textContent = expanded ? '退出铺满 ⛶' : '右侧铺满 ⛶';
  $('expand-player').setAttribute('aria-pressed', String(expanded));
  $('expand-player').title = expanded ? '恢复原布局（Esc）' : '铺满右侧，保留左侧目录';
}
async function closePlayer() {
  state.generation++;
  await saveProgress();
  dispose();
  state.current = null;
  state.jobId = null;
  setRightExpanded(false);
  $('player-section').hidden = true;
  await load();
}
function playbackState(title, note, value) {
  const contents = [el('strong', '', title)];
  if (note) contents.push(el('p', '', note));
  if (value !== undefined) {
    const track = el('div', 'conversion-track');
    const fill = el('i');
    fill.style.width = `${value}%`;
    track.append(fill);
    contents.push(track);
  }
  $('playback-state').replaceChildren(...contents);
  $('playback-state').hidden = false;
}
function startPlayback(url) {
  const current = state.current;
  if (!current) return;
  $('playback-state').hidden = true;
  $('player').hidden = false;
  $('cancel-button').hidden = true;
  $('convert-button').hidden = true;
  $('restart-button').hidden = false;
  state.jobId = null;
  current.url = url;
  current.completed = !!current.video.completed;
  current.saveReady = false;
  const art = new Artplayer({
    container: '#player', url, lang: 'zh-cn', theme: '#c65c37', volume: 0.8,
    autoplay: false, autoPlayback: false, playbackRate: true, setting: true,
    fullscreen: true, fullscreenWeb: true, pip: true, hotkey: true,
    moreVideoAttr: { preload: 'metadata' }
  });
  state.art = art;
  let restored = false;
  art.on('video:loadedmetadata', () => {
    if (state.art !== art || restored) return;
    restored = true;
    current.completed = !!current.video.completed;
    if (!current.video.completed && current.video.position > 0) {
      art.currentTime = Math.min(current.video.position, Math.max(0, art.duration - 0.25));
      $('playing-info').textContent = `已恢复至 ${time(current.video.position)} · ${time(art.duration)}`;
    } else {
      $('playing-info').textContent = `${time(art.duration)} · ${url.includes('kind=cache') ? '兼容格式缓存' : '直接播放原文件'}`;
    }
    current.saveReady = true;
  });
  art.on('video:play', () => {
    current.completed = false;
    revealCurrentVideo();
    saveProgress();
  });
  art.on('video:pause', () => saveProgress());
  art.on('video:seeked', () => { if (current.completed && art.currentTime < art.duration - 1) current.completed = false; saveProgress(); });
  art.on('video:ended', () => { current.completed = true; saveProgress(); });
  art.on('video:error', () => {
    current.saveReady = false;
    $('player').hidden = true;
    playbackState('当前视频无法直接播放', url.includes('kind=cache') ? '请清理缓存后重新转换，或检查源文件是否损坏。' : '可以先转换为兼容的 MP4 格式，再在浏览器中播放。');
    $('convert-button').hidden = url.includes('kind=cache');
    $('restart-button').hidden = true;
  });
}

async function openVideo(id, forceConvert = false) {
  const generation = ++state.generation;
  await saveProgress();
  if (generation !== state.generation) return;
  dispose();
  state.jobId = null;
  const video = state.videos.find(v => v.id === id);
  if (!video) return;
  state.current = { video: { ...video }, completed: false, saveReady: false };
  $('player-section').hidden = false;
  $('playing-title').textContent = video.name;
  $('playing-info').textContent = '读取视频信息中…';
  playbackState('准备放映', '正在检查视频格式与已保存的进度。');
  render();
  revealCurrentVideo();
  $('player-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const result = await api(`/api/videos/${id}/prepare`, 'POST', { forceConvert });
    if (generation !== state.generation) return;
    state.current.video = result.video;
    if (result.status === 'ready') startPlayback(result.url);
    else {
      state.jobId = result.id;
      showJob(result);
      await refreshJobs();
    }
  } catch (error) {
    if (generation !== state.generation) return;
    playbackState('暂时无法播放', error.message);
    $('playing-info').textContent = '';
    toast(error.message, true);
  }
}
function showJob(job) {
  if (!state.current) return;
  if (job.status === 'completed') { startPlayback(job.url); load().catch(() => {}); return; }
  if (job.status === 'queued' || job.status === 'converting') {
    playbackState(job.status === 'queued' ? '已加入转换队列' : `正在转换 · ${job.percent.toFixed(0)}%`,
      '首次播放需要等待转换完成，之后可以直接使用缓存。', job.percent);
    $('playing-info').textContent = job.status === 'queued' ? '等待前一个任务完成' : '原视频文件保持不变';
    $('cancel-button').hidden = false;
  } else {
    $('cancel-button').hidden = true;
    $('convert-button').hidden = false;
    playbackState(job.status === 'cancelled' ? '转换已取消' : '转换未完成', job.error || '再次点击“转换后播放”即可重新开始。');
    $('playing-info').textContent = '';
    state.jobId = null;
  }
}
async function refreshJobs() {
  const generation = state.generation;
  const jobs = await api('/api/jobs');
  state.jobs = jobs;
  $('jobs-count').textContent = jobs.filter(job => ['queued', 'converting'].includes(job.status)).length;
  if (generation === state.generation && state.jobId) {
    const job = jobs.find(j => j.id === state.jobId);
    if (job) showJob(job);
    else { state.jobId = null; playbackState('转换任务已结束', '请重新打开视频。'); $('cancel-button').hidden = true; }
  }
  if ($('jobs-dialog').open) renderJobs();
}
function renderJobs() {
  if (!state.jobs.length) { $('job-list').replaceChildren(el('p', 'small-note', '暂无转换任务。不兼容的视频在打开时会自动加入队列。')); return; }
  const names = { queued: '排队中', converting: '转换中', completed: '已完成', cancelled: '已取消', error: '转换失败' };
  $('job-list').replaceChildren(...state.jobs.map(job => {
    const item = el('div', 'job-item');
    item.append(el('h3', '', state.videos.find(v => v.id === job.videoId)?.name || '视频记录已移除'), progressTrack(job.percent));
    if (job.error) item.append(el('p', '', job.error));
    const bottom = el('div', 'job-bottom');
    bottom.append(el('span', '', `${names[job.status]}${job.status === 'converting' ? ` · ${job.percent.toFixed(0)}%` : ''}`));
    if (['queued', 'converting'].includes(job.status)) bottom.append(action('取消', 'quiet danger', async () => { await api(`/api/jobs/${job.id}/cancel`, 'POST'); await refreshJobs(); }));
    else if (job.status === 'completed') bottom.append(action('播放', 'quiet', async () => { $('jobs-dialog').close(); await openVideo(job.videoId); }));
    item.append(bottom);
    return item;
  }));
}

async function renderSources() {
  const sources = await api('/api/sources');
  $('source-list').replaceChildren(...sources.map(source => {
    const item = el('div', 'source-item');
    const copy = el('div', 'source-copy');
    copy.append(el('strong', '', source.path), el('small', '', source.type === 'folder' ? '文件夹 · 包含子文件夹' : '单个视频文件'));
    item.append(el('span', '', source.type === 'folder' ? '▱' : '▷'), copy, action('移除', 'quiet', async () => {
      if (!confirm('停止扫描这个来源？已导入的视频和历史记录会保留。')) return;
      await api(`/api/sources/${source.id}`, 'DELETE');
      await Promise.all([renderSources(), load()]);
    }));
    return item;
  }));
}
async function sourcesDialog() {
  if (!$('sources-dialog').open) $('sources-dialog').showModal();
  await renderSources();
}
let importing = false;
async function importPaths(paths) {
  if (!paths.length) return;
  importing = true;
  $('import-button').disabled = true;
  $('pick-folder').disabled = true;
  $('pick-file').disabled = true;
  $('import-state').textContent = '正在扫描，请稍候…';
  try {
    const result = await api('/api/sources', 'POST', { paths });
    $('paths').value = '';
    $('import-state').textContent = `扫描完成，找到 ${result.found} 个视频`;
    await Promise.all([load(), renderSources()]);
    if (result.warnings.length) toast(`扫描完成，部分路径无法读取：${result.warnings.slice(0, 3).join('；')}`, true);
    else toast(`已扫描 ${result.found} 个视频，重复文件已自动合并。`);
  } finally {
    importing = false;
    $('import-button').disabled = false;
    $('pick-folder').disabled = false;
    $('pick-file').disabled = false;
    if ($('import-state').textContent.startsWith('正在')) $('import-state').textContent = '';
  }
}
async function pick(kind) {
  if (importing) return;
  $('pick-folder').disabled = true;
  $('pick-file').disabled = true;
  $('import-state').textContent = '请在弹出的选择框中选择路径。';
  try {
    const result = await api('/api/pick', 'POST', { kind });
    await importPaths(result.paths);
  } finally {
    $('pick-folder').disabled = false;
    $('pick-file').disabled = false;
    if ($('import-state').textContent.startsWith('请选择')) $('import-state').textContent = '';
  }
}
async function refreshCache() {
  const usage = await api('/api/cache');
  $('cache-size').textContent = bytes(usage.bytes);
  $('cache-files').textContent = `${usage.files} 个缓存 / 临时文件`;
}
const on = (id, event, handler) => $(id).addEventListener(event, (...args) => Promise.resolve().then(() => handler(...args)).catch(error => toast(error.message, true)));
on('all-nav', 'click', () => { state.history = false; state.folder = null; render(); });
on('history-nav', 'click', () => { state.history = true; state.folder = null; render(); });
on('search', 'input', () => { state.search = $('search').value; render(); });
for (const id of ['add-button', 'empty-add', 'sources-nav']) on(id, 'click', sourcesDialog);
on('pick-folder', 'click', () => pick('folder'));
on('pick-file', 'click', () => pick('file'));
$('path-form').addEventListener('submit', event => {
  event.preventDefault();
  if (importing) return;
  const paths = $('paths').value.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
  if (!paths.length) { toast('请选择文件，或粘贴完整路径。'); return; }
  importPaths(paths).catch(error => toast(error.message, true));
});
on('refresh-button', 'click', async () => {
  $('refresh-button').disabled = true;
  try {
    const result = await api('/api/scan', 'POST');
    await load();
    toast(`刷新完成，扫描到 ${result.found} 个视频。${result.warnings.length ? '部分路径无法读取，请检查来源。' : ''}`, result.warnings.length > 0);
  } finally { $('refresh-button').disabled = false; }
});
on('expand-player', 'click', () => setRightExpanded(!$('player-section').classList.contains('right-expanded')));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('player-section').classList.contains('right-expanded')
    && !document.fullscreenElement && !state.art?.fullscreenWeb && !document.querySelector('dialog[open]')) {
    setRightExpanded(false);
    $('expand-player').focus();
  }
});
on('close-player', 'click', closePlayer);
on('restart-button', 'click', () => {
  if (!state.art || !state.current) return;
  state.current.completed = false;
  state.art.currentTime = 0;
  state.art.play().catch(() => {});
  saveProgress();
});
on('convert-button', 'click', () => state.current && openVideo(state.current.video.id, true));
on('cancel-button', 'click', async () => { if (state.jobId) { await api(`/api/jobs/${state.jobId}/cancel`, 'POST'); await refreshJobs(); } });
on('jobs-nav', 'click', async () => { $('jobs-dialog').showModal(); await refreshJobs(); });
on('cache-nav', 'click', async () => { $('cache-dialog').showModal(); await refreshCache(); });
on('clear-cache', 'click', async () => {
  if (!confirm('清理所有转换缓存并取消转换？\n原视频和观看记录不会删除。')) return;
  $('clear-cache').disabled = true;
  try {
    await closePlayer();
    await api('/api/cache', 'DELETE');
    await Promise.all([refreshCache(), refreshJobs()]);
    toast('转换缓存已清理。');
  } finally { $('clear-cache').disabled = false; }
});
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog && (event.offsetX < 0 || event.offsetY < 0 || event.offsetX > dialog.clientWidth || event.offsetY > dialog.clientHeight)) dialog.close(); });
setInterval(() => { if (state.art?.playing) saveProgress(); }, 5000);
let polling = false;
setInterval(async () => {
  if (polling) return;
  polling = true;
  try { await refreshJobs(); } catch { /* Active requests display errors; background polling retries quietly. */ }
  finally { polling = false; }
}, 2000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveProgress(true); });
window.addEventListener('pagehide', () => saveProgress(true));
window.addEventListener('focus', () => { if (!state.current) load().catch(() => {}); });
Promise.all([load(), refreshJobs(), api('/api/health').then(health => { if (!health.toolsReady) toast('格式工具尚未安装，请运行“首次安装.cmd”。', true); })]).catch(error => toast(error.message, true));
