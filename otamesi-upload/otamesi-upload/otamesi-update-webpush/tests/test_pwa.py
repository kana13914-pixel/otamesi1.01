"""PWAの検証（ヘッドレスChrome）。localhost で app/ を配信し、PWAとして最低限成立しているかを見る。
iOS固有の挙動（ホーム画面追加・通知許可）はここでは確認できないため、実機手順は docs/roadmap.md を参照。
"""
import functools
import json
import threading
import unittest
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

from playwright.sync_api import sync_playwright

APP_DIR = Path(__file__).resolve().parent.parent / "app"


class QuietHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".webmanifest": "application/manifest+json"}

    def log_message(self, *a):
        pass


class PwaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        handler = functools.partial(QuietHandler, directory=str(APP_DIR))
        cls.server = HTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}/"
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(
            executable_path="/usr/bin/google-chrome",
        )

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.shutdown()

    def new_page(self):
        ctx = self.browser.new_context()
        self.addCleanup(ctx.close)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "JSエラーが出ている"))
        return page

    def test_manifest_is_installable_shape(self):
        m = json.loads((APP_DIR / "manifest.webmanifest").read_text(encoding="utf-8"))
        self.assertEqual(m["display"], "standalone")
        sizes = {i["sizes"] for i in m["icons"]}
        self.assertTrue({"192x192", "512x512"} <= sizes)
        for icon in m["icons"]:
            self.assertTrue((APP_DIR / icon["src"]).exists(), icon["src"])
        self.assertTrue((APP_DIR / "icons/icon-180.png").exists())  # apple-touch-icon

    def test_page_loads_and_service_worker_registers(self):
        page = self.new_page()
        page.goto(self.base + "index.html")
        page.wait_for_selector("#sw-status.ok", timeout=10_000)
        self.assertEqual(page.text_content("#sw-status"), "登録済み")
        self.assertEqual(page.text_content("#source"), "URLを直接開いた")

    def test_opened_from_notification_is_detected(self):
        page = self.new_page()
        page.goto(self.base + "index.html?source=ntfy")
        self.assertEqual(page.text_content("#source"), "通知（ntfy）のタップ")

    def test_one_tap_plays_audio_after_opening_from_notification(self):
        page = self.new_page()
        page.goto(self.base + "index.html?source=ntfy")
        self.assertEqual(page.text_content("#audio-status"), "未再生")
        page.click("#play-voice")  # ボタン1回
        page.wait_for_selector("#audio-status.ok", timeout=5_000)
        page.wait_for_function("document.getElementById('audio-status').textContent === '再生完了'", timeout=5_000)

    def test_send_page_posts_scheduled_notification_to_ntfy(self):
        page = self.new_page()
        sent = []

        def fake_ntfy(route):
            sent.append(route.request)
            route.fulfill(status=200, content_type="application/json",
                          headers={"Access-Control-Allow-Origin": "*"},
                          body='{"id":"fake","time":1800000000}')

        page.route("https://ntfy.sh/", fake_ntfy)
        page.goto(self.base + "send.html")
        self.assertTrue(page.input_value("#click").endswith("/index.html?source=ntfy"))
        page.click("#send")  # トピック未入力
        self.assertIn("トピック名を入力", page.text_content("#send-status"))
        page.fill("#topic", "test-topic")
        page.select_option("#delay", "5")
        page.click("#send")
        page.wait_for_selector("#send-status.ok", timeout=5_000)
        self.assertEqual(len(sent), 1)
        body = json.loads(sent[0].post_data)
        self.assertEqual(body["topic"], "test-topic")
        self.assertTrue(body["delay"].isdigit())
        self.assertIn("予定", body["message"])
        # application/json を付けるとCORSの事前確認が必要になるため、付けていないことを確認
        self.assertNotIn("json", sent[0].headers.get("content-type", ""))

    def test_generated_topic_is_random_and_remembered(self):
        page = self.new_page()
        page.goto(self.base + "send.html")
        page.click("#gen-topic")
        t1 = page.input_value("#topic")
        self.assertRegex(t1, r"^kiinichi-[0-9a-f]{24}$")
        page.reload()
        self.assertEqual(page.input_value("#topic"), t1)

    def test_send_page_web_push_calls_worker_with_token(self):
        page = self.new_page()
        calls = []

        def fake_worker(route):
            calls.append(route.request)
            if route.request.method == "OPTIONS":
                route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*",
                                                   "Access-Control-Allow-Headers": "Authorization, Content-Type",
                                                   "Access-Control-Allow-Methods": "GET, POST, OPTIONS"})
                return
            route.fulfill(status=200, content_type="application/json",
                          headers={"Access-Control-Allow-Origin": "*"},
                          body='{"ok":true,"scheduled":true,"at":1800000000000}')

        page.route("https://kiinichi.example.workers.dev/**", fake_worker)
        page.goto(self.base + "send.html")
        page.click("#wp-send")
        self.assertIn("URL", page.text_content("#wp-status"))  # 未設定ならURL入力を促す
        page.fill("#wp-worker-url", "https://kiinichi.example.workers.dev/")
        page.dispatch_event("#wp-worker-url", "change")
        page.fill("#wp-token", "tok-123")
        page.dispatch_event("#wp-token", "change")
        page.select_option("#delay", "5")
        page.click("#wp-send")
        page.wait_for_selector("#wp-status.ok", timeout=5_000)
        self.assertIn("予約しました", page.text_content("#wp-status"))
        post = [c for c in calls if c.method == "POST"][0]
        self.assertEqual(post.url, "https://kiinichi.example.workers.dev/api/send")
        self.assertEqual(post.headers["authorization"], "Bearer tok-123")
        body = json.loads(post.post_data)
        self.assertEqual(body["delaySeconds"], 300)
        self.assertTrue(body["url"].endswith("/index.html?source=webpush"))
        page.reload()  # 設定は端末に保存される
        self.assertEqual(page.input_value("#wp-worker-url"), "https://kiinichi.example.workers.dev/")

    def test_index_enable_push_outside_home_screen_explains_why(self):
        page = self.new_page()
        page.goto(self.base + "index.html")
        page.wait_for_selector("#sw-status.ok", timeout=10_000)
        page.fill("#worker-url", "https://kiinichi.example.workers.dev")
        page.dispatch_event("#worker-url", "change")
        page.route("https://kiinichi.example.workers.dev/**", lambda r: r.fulfill(
            status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"},
            body='{"publicKey":"BAAA"}'))
        page.click("#enable-push")
        page.wait_for_selector("#push-status.ng", timeout=10_000)
        self.assertIn("失敗", page.text_content("#push-status"))

    def test_webpush_source_is_detected(self):
        page = self.new_page()
        page.goto(self.base + "index.html?source=webpush")
        self.assertEqual(page.text_content("#source"), "通知（Web Push）のタップ")


if __name__ == "__main__":
    unittest.main()
