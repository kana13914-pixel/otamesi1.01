// フェーズ0 技術検証用。起動状態を表示し、実機確認で何が起きたか目で見えるようにする。

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function describeSource() {
  const src = new URLSearchParams(location.search).get('source');
  if (src === 'ntfy') return '通知（ntfy）のタップ';
  if (src === 'homescreen') return 'ホーム画面のアイコン';
  return 'URLを直接開いた';
}

function setText(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  if (cls) el.className = cls;
}

setText('display-mode', isStandalone() ? 'ホーム画面アプリ（standalone）' : 'ブラウザ内', isStandalone() ? 'ok' : '');
setText('source', describeSource());
setText('opened-at', new Date().toLocaleString('ja-JP'));

// 音声再生：ボタン1回で鳴らす。今はテスト用チャイム（合成音）。本番の声素材は人間が用意する（NEEDS_HUMAN）。
const voice = new Audio('audio/test-chime.wav');
voice.preload = 'auto';
voice.addEventListener('playing', () => setText('audio-status', '再生中', 'ok'));
voice.addEventListener('ended', () => setText('audio-status', '再生完了', 'ok'));
document.getElementById('play-voice').addEventListener('click', () => {
  voice.currentTime = 0;
  voice.play().catch((e) => setText('audio-status', '再生失敗: ' + e.name, 'ng'));
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => setText('sw-status', '登録済み', 'ok'))
    .catch((e) => setText('sw-status', '登録失敗: ' + e.message, 'ng'));
} else {
  setText('sw-status', '非対応', 'ng');
}
