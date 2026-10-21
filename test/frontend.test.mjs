import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile, mkdtemp, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createApp, root } from '../server.mjs';

// DOM integration uses the real ArtPlayer distribution. Playback events are simulated;
// it does not replace a browser's codec, rendering, native picker or visual checks.
test('Chinese UI import, folder tree navigation, real ArtPlayer resume and history', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'local-video-ui-'));
  const media = path.join(sandbox, '课程 中文 & 测试.mp4');
  // A small placeholder is enough: probe is preseeded; this test exercises UI integration.
  await writePlaceholder(media);
  const service = await createApp({ dataDir: path.join(sandbox, 'state'), allowDialogs: false });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const dom = new JSDOM(await readFile(path.join(root, 'public/index.html'), 'utf8'), {
    url: base + '/', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const win = dom.window;
  const errors = [];
  win.addEventListener('error', event => errors.push(event.message));
  win.fetch = (url, options) => fetch(new URL(url, base), options);
  win.HTMLElement.prototype.scrollIntoView = () => {};
  win.confirm = () => true;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  win.URL.revokeObjectURL = () => {};
  let paused = true;
  Object.defineProperty(win.HTMLMediaElement.prototype, 'duration', { get: () => 120 });
  Object.defineProperty(win.HTMLMediaElement.prototype, 'paused', { get: () => paused });
  win.HTMLMediaElement.prototype.load = function () {};
  win.HTMLMediaElement.prototype.play = function () { paused = false; this.dispatchEvent(new win.Event('play')); return Promise.resolve(); };
  win.HTMLMediaElement.prototype.pause = function () { paused = true; this.dispatchEvent(new win.Event('pause')); };
  win.HTMLMediaElement.prototype.canPlayType = () => 'probably';
  let beacons = [];
  win.navigator.sendBeacon = (url, body) => { beacons.push({ url, body }); return true; };
  const $ = id => win.document.getElementById(id);
  async function until(condition) {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      if (await condition()) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`UI condition timed out. Errors: ${errors.join('; ')}. Notice: ${$('notice').textContent}`);
  }
  try {
    win.eval(await readFile(path.join(root, 'node_modules/artplayer/dist/artplayer.js'), 'utf8'));
    win.eval(await readFile(path.join(root, 'public/app.js'), 'utf8'));
    await until(() => !$('empty-state').hidden);
    assert.match($('empty-title').textContent, /第一场/);
    $('paths').value = media;
    $('path-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => win.document.querySelectorAll('.video-card').length === 1);
    const video = service.library.list()[0];
    assert.match(win.document.querySelector('.video-name').textContent, /中文 &/);
    assert.equal(win.document.querySelector('.video-name').children.length, 0, 'filenames are rendered as text');
    service.library.db.prepare('UPDATE videos SET metadata=?, duration=120, position=35, last_watched=? WHERE id=?')
      .run(JSON.stringify({ direct: true, mime: 'video/mp4', duration: 120 }), Date.now(), video.id);
    win.document.querySelector('.video-open').click();
    await until(() => win.document.querySelector('#player video'));
    let element = win.document.querySelector('#player video');
    element.dispatchEvent(new win.Event('loadedmetadata'));
    assert.equal(element.currentTime, 35);
    assert.match($('playing-info').textContent, /00:35/);
    assert.ok(win.document.querySelector('.art-controls'), 'ArtPlayer control tree exists');
    $('expand-player').click();
    await until(() => $('player-section').classList.contains('right-expanded'));
    assert.equal($('expand-player').getAttribute('aria-pressed'), 'true');
    assert.ok(win.document.querySelector('#player video') === element, 'expanding keeps the same media element');
    assert.equal(element.currentTime, 35);
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal($('player-section').classList.contains('right-expanded'), false);
    assert.equal(win.document.body.classList.contains('right-player-open'), false);
    assert.equal(element.currentTime, 35, 'Escape preserves playback position');
    $('expand-player').click();
    await until(() => $('player-section').classList.contains('right-expanded'));
    element.currentTime = 48;
    await element.play();
    element.pause();
    await until(() => service.library.get(video.id).position === 48);
    element.currentTime = 120;
    element.dispatchEvent(new win.Event('ended'));
    await until(() => service.library.get(video.id).completed === 1);
    $('close-player').click();
    await until(() => $('player-section').hidden);
    assert.equal(win.document.body.classList.contains('right-player-open'), false, 'closing restores page scrolling');
    assert.equal($('expand-player').getAttribute('aria-pressed'), 'false');
    $('history-nav').click();
    await until(() => $('list-title').textContent === '最近观看');
    assert.equal(win.document.querySelectorAll('.video-card').length, 1);
    assert.match(win.document.querySelector('.video-meta').textContent, /已看完/);
    win.document.querySelector('.video-open').click();
    await until(() => win.document.querySelector('#player video'));
    element = win.document.querySelector('#player video');
    element.dispatchEvent(new win.Event('loadedmetadata'));
    assert.equal(element.currentTime, 0, 'completed video reopens at the beginning');
    $('restart-button').click();
    await until(() => service.library.get(video.id).completed === 0);
    element.currentTime = 13;
    win.dispatchEvent(new win.Event('pagehide'));
    assert.equal(beacons.length, 1);
    assert.match(beacons[0].url, /\/progress$/);
    $('search').value = '不存在';
    $('search').dispatchEvent(new win.Event('input'));
    await until(() => !$('empty-state').hidden);
    assert.match($('empty-title').textContent, /没有找到/);

    // Nested folders, overlapping sources and a sibling with the same prefix.
    const libraryDir = path.join(sandbox, '资料库');
    const chapter = path.join(libraryDir, '第一章');
    const nested = path.join(chapter, '子目录');
    const sibling = path.join(libraryDir, '第一章备份');
    for (const directory of [nested, sibling]) await mkdir(directory, { recursive: true });
    for (const [directory, name] of [[chapter, '课一.mp4'], [nested, '课二.mp4'], [sibling, '课三.mp4']]) {
      await writePlaceholder(path.join(directory, name));
    }
    const otherDir = await mkdtemp(path.join(tmpdir(), 'local-video-ui-other-'));
    await writePlaceholder(path.join(otherDir, '其他来源.mp4'));
    await service.library.addSources([libraryDir, nested, otherDir]);
    $('search').value = '';
    $('search').dispatchEvent(new win.Event('input'));
    $('all-nav').click();
    $('refresh-button').click();
    await until(() => $('all-count').textContent === '5');
    const key = directory => directory.replace(/\\/g, '/').toLowerCase();
    const folderButton = directory => [...win.document.querySelectorAll('.folder-select')].find(button => button.dataset.directory === key(directory));
    assert.equal(win.document.querySelectorAll('.folder-roots > .folder-node').length, 2);
    assert.equal(win.document.querySelectorAll('.tree-video').length, 5, 'overlapping sources do not duplicate videos');
    const chapterButton = folderButton(chapter);
    const toggle = chapterButton.previousElementSibling;
    const children = win.document.getElementById(toggle.getAttribute('aria-controls'));
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    toggle.click();
    await until(() => !children.hidden);
    assert.equal($('all-nav').classList.contains('active'), true, 'expanding does not apply a filter');
    chapterButton.click();
    await until(() => $('list-title').textContent === '第一章');
    assert.equal(win.document.querySelectorAll('.video-card').length, 2, 'includes descendants but excludes sibling prefixes');
    assert.equal(chapterButton.getAttribute('aria-pressed'), 'true');
    assert.equal($('all-nav').classList.contains('active'), false);
    assert.ok(win.document.querySelector('#player video') === element, 'folder navigation keeps the player intact');
    $('search').value = '课二';
    $('search').dispatchEvent(new win.Event('input'));
    await until(() => win.document.querySelectorAll('.video-card').length === 1);
    assert.equal(win.document.querySelector('.video-name').textContent, '课二.mp4');
    $('search').value = '';
    $('search').dispatchEvent(new win.Event('input'));
    toggle.click();
    await until(() => children.hidden);
    assert.equal(win.document.querySelectorAll('.video-card').length, 2, 'collapsing preserves folder selection');
    element.currentTime = 25;
    element.pause();
    await until(() => service.library.get(video.id).position === 25);
    assert.ok(children.hidden, 'progress updates preserve expansion state and tree DOM');
    $('refresh-button').click();
    await until(() => folderButton(chapter) !== chapterButton);
    assert.equal(folderButton(chapter).previousElementSibling.getAttribute('aria-expanded'), 'false', 'refresh preserves collapsed state');
    assert.equal(win.document.querySelectorAll('.video-card').length, 2);
    $('history-nav').click();
    await until(() => $('list-title').textContent === '最近观看');
    assert.equal(win.document.querySelectorAll('.video-card').length, 1, 'history clears the folder filter');
    folderButton(otherDir).click();
    await until(() => win.document.querySelector('.video-name')?.textContent === '其他来源.mp4');
    const treeVideo = [...win.document.querySelectorAll('.tree-video')].find(button => button.dataset.videoId === video.id);
    $('expand-player').click();
    await until(() => $('player-section').classList.contains('right-expanded'));
    treeVideo.click();
    await until(() => win.document.querySelector('#player video') !== element);
    element = win.document.querySelector('#player video');
    element.dispatchEvent(new win.Event('loadedmetadata'));
    assert.equal(element.currentTime, 25, 'tree video selection uses the persisted resume position');
    assert.equal(treeVideo.getAttribute('aria-current'), 'true');
    assert.ok($('player-section').classList.contains('right-expanded'), 'switching through the tree preserves expanded mode');
    $('expand-player').click();
    await until(() => !$('player-section').classList.contains('right-expanded'));
    assert.equal(element.currentTime, 25, 'restoring layout does not reset the video');
    $('all-nav').click();
    await until(() => win.document.querySelectorAll('.video-card').length === 5);
    assert.equal(win.document.querySelectorAll('.folder-select.selected').length, 0);

    // Opening a deeply nested video must reveal its complete path in the sidebar.
    const nestedVideo = service.library.list().find(entry => entry.directory === nested);
    service.library.db.prepare('UPDATE videos SET metadata=?, duration=120, position=17, last_watched=? WHERE id=?')
      .run(JSON.stringify({ direct: true, mime: 'video/mp4', duration: 120 }), Date.now(), nestedVideo.id);
    const ancestorFolders = [sandbox, libraryDir, chapter, nested];
    for (const directory of ancestorFolders) {
      const disclosure = folderButton(directory).previousElementSibling;
      if (disclosure.getAttribute('aria-expanded') === 'true') {
        disclosure.click();
        await until(() => disclosure.getAttribute('aria-expanded') === 'false');
      }
    }
    const treeEntry = [...win.document.querySelectorAll('.tree-video')].find(button => button.dataset.videoId === nestedVideo.id);
    $('folder-tree').getBoundingClientRect = () => ({ top: 100, bottom: 200 });
    treeEntry.getBoundingClientRect = () => ({ top: 300, bottom: 330 });
    $('folder-tree').scrollTop = 0;
    const nestedCard = [...win.document.querySelectorAll('.video-open')].find(button => button.getAttribute('aria-label') === `播放 ${nestedVideo.name}`);
    nestedCard.click();
    await until(() => win.document.querySelector('#player video') !== element);
    element = win.document.querySelector('#player video');
    element.dispatchEvent(new win.Event('loadedmetadata'));
    for (const directory of ancestorFolders) {
      assert.equal(folderButton(directory).previousElementSibling.getAttribute('aria-expanded'), 'true', `reveals ancestor ${directory}`);
    }
    assert.ok(!treeEntry.closest('[hidden]'), 'current video is not inside a collapsed group');
    assert.equal(treeEntry.getAttribute('aria-current'), 'true');
    assert.equal($('folder-tree').scrollTop, 130, 'only the folder tree scrolls to reveal the current row');
    assert.equal(element.currentTime, 17, 'revealing the path preserves resume');
    assert.equal($('all-nav').classList.contains('active'), true, 'reveal does not change the list filter');
    const nestedDisclosure = folderButton(nested).previousElementSibling;
    nestedDisclosure.click();
    await until(() => nestedDisclosure.getAttribute('aria-expanded') === 'false');
    treeEntry.getBoundingClientRect = () => ({ top: 140, bottom: 170 });
    await element.play();
    assert.equal(nestedDisclosure.getAttribute('aria-expanded'), 'true', 'resuming playback reveals the row again');
    assert.equal($('folder-tree').scrollTop, 130, 'a visible current row does not cause extra scrolling');
    assert.deepEqual(errors, []);
  } finally {
    win.close();
    server.close();
    server.closeAllConnections();
    await service.close();
  }
});

async function writePlaceholder(filename) {
  // Use an existing local text asset; no external media requests are made.
  await copyFile(path.join(root, 'package.json'), filename);
}
