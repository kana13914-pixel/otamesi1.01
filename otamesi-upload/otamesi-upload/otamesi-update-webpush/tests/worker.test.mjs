// Worker の検証（Node の WebCrypto で実行）。実際のプッシュサービスには送らず、
// 送信内容を受け取り、ブラウザ側の鍵で復号できること・VAPID署名が正しいことを確かめる。
// 実行: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { _internal } from '../worker/worker.js';

const { b64url, unb64url, hkdf, concat } = _internal;
const enc = new TextEncoder();
const dec = new TextDecoder();

function makeKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}

// ブラウザ（User Agent）役の鍵と購読情報を作る
async function makeBrowser() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    pair, pub, auth,
    subscription: { endpoint: 'https://web.push.apple.com/QXabc123', keys: { p256dh: b64url(pub), auth: b64url(auth) } },
  };
}

// RFC 8291 の復号（ブラウザ側の処理を再現）
async function decrypt(browser, body) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, browser.pair.privateKey, 256));
  const ikm = await hkdf(browser.auth, ecdh, concat(enc.encode('WebPush: info\0'), browser.pub, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
  assert.equal(plain[plain.length - 1], 2, '最終レコードの区切りがある');
  return JSON.parse(dec.decode(plain.slice(0, -1)));
}

async function verifyVapid(authHeader, endpoint, vapidPublic) {
  const m = authHeader.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, 'vapid t=..., k=... の形式');
  const [h, c, s] = m[1].split('.');
  assert.equal(m[2], vapidPublic);
  const claims = JSON.parse(dec.decode(unb64url(c)));
  assert.equal(claims.aud, new URL(endpoint).origin);
  assert.ok(claims.sub.startsWith('https://') || claims.sub.startsWith('mailto:'));
  assert.ok(claims.exp - Date.now() / 1000 <= 24 * 3600, 'exp は24時間以内');
  const key = await crypto.subtle.importKey('raw', unb64url(vapidPublic), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64url(s), enc.encode(`${h}.${c}`));
  assert.ok(ok, 'VAPID署名が正しい');
}

const ORIGIN = 'https://kana13914-pixel.github.io';
function req(path, { method = 'GET', token, body } = {}) {
  const headers = { Origin: ORIGIN };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request('https://kiinichi.example.workers.dev' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function setup() {
  const env = { PUSH_KV: makeKV(), APP_TOKEN: 'secret-token-123' };
  const pushes = [];
  globalThis.fetch = async (url, init) => {
    pushes.push({ url, init });
    return new Response('', { status: 201 });
  };
  return { env, pushes };
}

test('VAPID公開鍵は初回に自動生成され、以後同じ値', async () => {
  const { env } = setup();
  const r1 = await (await worker.fetch(req('/api/vapid-public-key'), env)).json();
  const r2 = await (await worker.fetch(req('/api/vapid-public-key'), env)).json();
  assert.equal(unb64url(r1.publicKey).length, 65);
  assert.equal(r1.publicKey, r2.publicKey);
});

test('合言葉なし・違う合言葉は401、未設定は500', async () => {
  const { env } = setup();
  assert.equal((await worker.fetch(req('/api/status'), env)).status, 401);
  assert.equal((await worker.fetch(req('/api/status', { token: 'wrong' }), env)).status, 401);
  assert.equal((await worker.fetch(req('/api/status', { token: 'x' }), { PUSH_KV: makeKV() })).status, 500);
});

test('CORS: 許可したサイトからの事前確認に応答する', async () => {
  const { env } = setup();
  const res = await worker.fetch(req('/api/send', { method: 'OPTIONS' }), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});

test('購読→即時送信：暗号化された本文をブラウザ側の鍵で復号でき、VAPID署名も正しい', async () => {
  const { env, pushes } = setup();
  const browser = await makeBrowser();
  const sub = await worker.fetch(req('/api/subscribe', { method: 'POST', token: env.APP_TOKEN, body: browser.subscription }), env);
  assert.equal(sub.status, 200);
  const res = await worker.fetch(req('/api/send', { method: 'POST', token: env.APP_TOKEN, body: { title: 'タイトル', body: '本文', url: ORIGIN + '/x/app/index.html?source=webpush' } }), env);
  assert.equal(res.status, 200);
  assert.equal(pushes.length, 1);
  const { url, init } = pushes[0];
  assert.equal(url, browser.subscription.endpoint);
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(Number(init.headers.TTL) > 0);
  const msg = await decrypt(browser, init.body);
  assert.deepEqual(msg, { title: 'タイトル', body: '本文', url: ORIGIN + '/x/app/index.html?source=webpush' });
  const vapid = await (await worker.fetch(req('/api/vapid-public-key'), env)).json();
  await verifyVapid(init.headers.Authorization, url, vapid.publicKey);
});

test('予約送信：予定の30秒前より前は送らず、以降のCron実行で1回だけ送る', async () => {
  const { env, pushes } = setup();
  const browser = await makeBrowser();
  await worker.fetch(req('/api/subscribe', { method: 'POST', token: env.APP_TOKEN, body: browser.subscription }), env);
  const r = await (await worker.fetch(req('/api/send', { method: 'POST', token: env.APP_TOKEN, body: { delaySeconds: 300 } }), env)).json();
  assert.equal(r.scheduled, true);
  assert.equal(pushes.length, 0);
  assert.deepEqual(await _internal.runDue(env, r.at - 31000), { sent: 0, left: 1 }); // 31秒前はまだ
  assert.deepEqual(await _internal.runDue(env, r.at - 29000), { sent: 1, left: 0 }); // 30秒前以降は送る
  assert.deepEqual(await _internal.runDue(env, r.at + 61000), { sent: 0, left: 0 }); // 二重送信しない
  assert.equal(pushes.length, 1);
  const msg = await decrypt(browser, pushes[0].init.body);
  assert.equal(msg.title, 'キィニチくん（検証）');
});

test('Cron の scheduled ハンドラが予約キューを処理する', async () => {
  const { env, pushes } = setup();
  const browser = await makeBrowser();
  await worker.fetch(req('/api/subscribe', { method: 'POST', token: env.APP_TOKEN, body: browser.subscription }), env);
  await env.PUSH_KV.put('queue', JSON.stringify([{ id: 'a', at: Date.now() - 1, title: 't', body: 'b' }]));
  let p;
  worker.scheduled({}, env, { waitUntil: (x) => { p = x; } });
  await p;
  assert.equal(pushes.length, 1);
});

test('購読がない状態での送信は分かるエラーを返す', async () => {
  const { env } = setup();
  const res = await worker.fetch(req('/api/send', { method: 'POST', token: env.APP_TOKEN, body: {} }), env);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /購読がありません/);
});

test('プッシュサービスが410を返したら購読を消す', async () => {
  const { env } = setup();
  const browser = await makeBrowser();
  await worker.fetch(req('/api/subscribe', { method: 'POST', token: env.APP_TOKEN, body: browser.subscription }), env);
  globalThis.fetch = async () => new Response('gone', { status: 410 });
  await worker.fetch(req('/api/send', { method: 'POST', token: env.APP_TOKEN, body: {} }), env);
  assert.equal(await env.PUSH_KV.get('subscription'), null);
});

test('不正な購読情報・3日超の予約は拒否する', async () => {
  const { env } = setup();
  assert.equal((await worker.fetch(req('/api/subscribe', { method: 'POST', token: env.APP_TOKEN, body: { endpoint: 'http://x' } }), env)).status, 400);
  assert.equal((await worker.fetch(req('/api/send', { method: 'POST', token: env.APP_TOKEN, body: { delaySeconds: 4 * 86400 } }), env)).status, 400);
});
