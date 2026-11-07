// 検証用の設定（Web Push 送信サーバーのURLと合言葉）。
// ユーザーが画面で入力し、この端末のブラウザ内（localStorage）にだけ保存する。コードやリポジトリには書かない。
// 注意：iPhoneでは Safari とホーム画面のアプリで保存場所が別なので、それぞれで入力が必要。
const Settings = (() => {
  const KEYS = { workerUrl: 'phase0.workerUrl', appToken: 'phase0.appToken' };
  function get(name) {
    try { return localStorage.getItem(KEYS[name]) || ''; } catch (_) { return ''; }
  }
  function set(name, value) {
    try { localStorage.setItem(KEYS[name], value); } catch (_) {}
  }
  function workerUrl() {
    return get('workerUrl').trim().replace(/\/+$/, '');
  }
  // input 要素と設定を結びつける
  function bind(inputId, name) {
    const el = document.getElementById(inputId);
    el.value = get(name);
    el.addEventListener('change', () => set(name, el.value.trim()));
  }
  async function api(path, options = {}) {
    const base = workerUrl();
    if (!/^https:\/\//.test(base)) throw new Error('送信サーバーのURL（https://…workers.dev）を入力してください');
    const headers = { ...(options.headers || {}) };
    if (options.auth !== false) {
      const token = get('appToken').trim();
      if (!token) throw new Error('合言葉を入力してください');
      headers.Authorization = 'Bearer ' + token;
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + path, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }
  return { get, set, bind, workerUrl, api };
})();
