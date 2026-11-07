"""ntfy_send.py の検証。本物の ntfy には送らず、ローカルの偽サーバーで受け取った内容を確認する。"""
import json
import sys
import threading
import unittest
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import ntfy_send  # noqa: E402


class FakeNtfy(BaseHTTPRequestHandler):
    received = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        FakeNtfy.received.append({"path": self.path, "headers": dict(self.headers), "body": json.loads(body)})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"id": "fake123", "time": 1_800_000_000}).encode())

    def log_message(self, *a):
        pass


class NtfySendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeNtfy)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.env = {
            "NTFY_TOPIC": "test-topic",
            "NTFY_SERVER": f"http://127.0.0.1:{cls.server.server_port}",
            "APP_URL": "https://example.invalid/app/index.html",
        }

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeNtfy.received.clear()

    def test_immediate_send_with_click_url(self):
        payload = ntfy_send.build_payload(self.env, "タイトル", "本文")
        result = ntfy_send.send(self.env, payload)
        self.assertEqual(result["id"], "fake123")
        got = FakeNtfy.received[0]
        self.assertEqual(got["path"], "/")
        self.assertEqual(got["body"]["topic"], "test-topic")
        self.assertEqual(got["body"]["title"], "タイトル")  # 日本語がそのまま届く
        self.assertEqual(got["body"]["click"], "https://example.invalid/app/index.html?source=ntfy")
        self.assertNotIn("delay", got["body"])
        self.assertNotIn("Authorization", got["headers"])

    def test_token_header_when_set(self):
        env = dict(self.env, NTFY_TOKEN="tk_dummy")
        ntfy_send.send(env, ntfy_send.build_payload(env, "t", "m"))
        self.assertEqual(FakeNtfy.received[0]["headers"]["Authorization"], "Bearer tk_dummy")

    def test_schedule_at_clock_time_is_sent_as_server_side_delay(self):
        now = datetime(2026, 11, 6, 20, 0, 0)
        payload = ntfy_send.build_payload(self.env, "t", "m", at="21:30", now=now)
        ntfy_send.send(self.env, payload)
        body = FakeNtfy.received[0]["body"]
        self.assertEqual(int(body["delay"]), int(datetime(2026, 11, 6, 21, 30).timestamp()))
        self.assertEqual(body["message"], "m（予定 21:30:00）")

    def test_schedule_at_past_time_rolls_to_next_day(self):
        now = datetime(2026, 11, 6, 22, 0, 0)
        payload = ntfy_send.build_payload(self.env, "t", "m", at="21:30", now=now)
        self.assertEqual(int(payload["delay"]), int(datetime(2026, 11, 7, 21, 30).timestamp()))

    def test_schedule_in_duration(self):
        now = datetime(2026, 11, 6, 20, 0, 0)
        payload = ntfy_send.build_payload(self.env, "t", "m", in_="5m", now=now)
        self.assertEqual(int(payload["delay"]), int(datetime(2026, 11, 6, 20, 5).timestamp()))
        self.assertIn("予定 20:05:00", payload["message"])

    def test_unknown_delay_format_is_passed_through(self):
        payload = ntfy_send.build_payload(self.env, "t", "m", at="tomorrow 3pm")
        self.assertEqual(payload["delay"], "tomorrow 3pm")
        self.assertEqual(payload["message"], "m")

    def test_at_and_in_together_is_rejected(self):
        with self.assertRaises(SystemExit):
            ntfy_send.build_payload(self.env, "t", "m", at="21:30", in_="5m")

    def test_missing_topic_stops(self):
        with self.assertRaises(SystemExit):
            ntfy_send.build_payload({}, "t", "m")


if __name__ == "__main__":
    unittest.main()
