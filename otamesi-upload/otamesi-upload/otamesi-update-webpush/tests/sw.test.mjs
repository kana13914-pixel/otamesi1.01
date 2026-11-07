// Service Worker の push / notificationclick 処理の検証。sw.js を偽の self の上で実行する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SCOPE = 'https://kana13914-pixel.github.io/x/app/';

function loadSw({ windows = [] } = {}) {
  const handlers = {};
  const shown = [];
  const opened = [];
  const self = {
    location: new URL(SCOPE + 'sw.js'),
    registration: { scope: SCOPE, showNotification: async (title, opts) => { shown.push({ title, opts }); } },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url) => { opened.push(url); },
      claim: () => {},
    },
    skipWaiting: () => {},
    addEventListener: (type, fn) => { handlers[type] = fn; },
  };
  vm.runInNewContext(readFileSync(new URL('../app/sw.js', import.meta.url), 'utf8'), { self, caches: {}, fetch: () => {}, URL });
  return { handlers, shown, opened };
}

function fire(handler, event) {
  let p;
  handler({ ...event, waitUntil: (x) => { p = x; } });
  return p;
}

test('push を受けたらタイトル・本文・タップ先URLつきで通知を出す', async () => {
  const { handlers, shown } = loadSw();
  const payload = { title: 'キィニチくん（検証）', body: '本文', url: SCOPE + 'index.html?source=webpush' };
  await fire(handlers.push, { data: { json: () => payload, text: () => JSON.stringify(payload) } });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'キィニチくん（検証）');
  assert.equal(shown[0].opts.body, '本文');
  assert.equal(shown[0].opts.data.url, payload.url);
});

test('URLなしの push でも index.html?source=webpush を開く設定になる', async () => {
  const { handlers, shown } = loadSw();
  await fire(handlers.push, { data: { json: () => ({ title: 't' }) } });
  assert.equal(shown[0].opts.data.url, SCOPE + 'index.html?source=webpush');
});

test('通知タップ：開いている画面がなければ新しく開く', async () => {
  const { handlers, opened } = loadSw();
  let closed = false;
  await fire(handlers.notificationclick, { notification: { close: () => { closed = true; }, data: { url: SCOPE + 'index.html?source=webpush' } } });
  assert.ok(closed);
  assert.deepEqual(opened, [SCOPE + 'index.html?source=webpush']);
});

test('通知タップ：開いている画面があれば前面に出して移動する', async () => {
  const calls = [];
  const win = { focus: async () => calls.push('focus'), navigate: async (u) => calls.push('navigate ' + u) };
  const { handlers, opened } = loadSw({ windows: [win] });
  await fire(handlers.notificationclick, { notification: { close() {}, data: { url: SCOPE + 'index.html?source=webpush' } } });
  assert.deepEqual(calls, ['focus', 'navigate ' + SCOPE + 'index.html?source=webpush']);
  assert.deepEqual(opened, []);
});
