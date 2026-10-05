import datetime
import http.server
import threading
import time
import unittest
from unittest.mock import patch
from test_host import host, job

class TimezoneTests(unittest.TestCase):
    def test_optional_http_deadline_stops_a_stalled_schedule(self):
        release = threading.Event()
        class StalledSchedule(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                release.wait(3)
                self.send_response(200)
                self.end_headers()
            def log_message(self, *_args):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), StalledSchedule)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        start = time.monotonic()
        try:
            with self.assertRaises(host.Failure):
                host.get_json(f"http://127.0.0.1:{server.server_port}", "synthetic", "/api/w/fixture/schedules/list", deadline=start + 0.1)
            self.assertLess(time.monotonic() - start, 1.5)
        finally:
            release.set()
            server.shutdown()
            server.server_close()
            thread.join()

    def test_new_schedule_trigger_contract(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        payload = job(trigger_kind="schedule", trigger="f/tests/nightly")
        zones = {"f/tests/nightly": "Asia/Tokyo"}
        self.assertEqual(host.runs([payload], "fixture", now, zones)[0]["timezone"], "Asia/Tokyo")
        with patch.object(host, "get_json", return_value={"path": "f/tests/nightly", "timezone": "Asia/Tokyo"}) as get:
            self.assertEqual(host.schedule_timezones("https://fixture.example", "synthetic", "fixture", [payload], exact=True), zones)
            self.assertTrue(get.call_args.args[2].endswith("/get/f/tests/nightly"))
        with patch.object(host, "get_json") as get:
            self.assertEqual(host.schedule_timezones("https://fixture.example", "synthetic", "fixture", [job(trigger_kind="webhook", trigger="f/tests/nightly")]), {})
            get.assert_not_called()

    def test_optional_schedule_lookup_is_bounded(self):
        counter = 0
        def page(*args, **kwargs):
            nonlocal counter
            counter += 1
            if counter > 10:
                self.fail("Schedule pagination exceeded its bound")
            return [{"path": f"f/other/{counter}/{index}", "timezone": "UTC"} for index in range(100)]
        with patch.object(host, "get_json", side_effect=page):
            self.assertEqual(host.schedule_timezones("https://fixture.example", "synthetic", "fixture", [job(schedule_path="f/tests/deleted")]), {})
        with patch.object(host.time, "monotonic", side_effect=[100, 103]), patch.object(host, "get_json") as get:
            self.assertEqual(host.schedule_timezones("https://fixture.example", "synthetic", "fixture", [job(schedule_path="f/tests/nightly")]), {})
            get.assert_not_called()

    def test_named_zones_and_instant_preservation(self):
        for zone in ["UTC", "America/New_York", "America/Phoenix", "Asia/Kathmandu"]:
            self.assertTrue(host.valid_timezone(zone))
        for zone in ["Bad/Zone", "+05:45", "../UTC", {}, None]:
            self.assertFalse(host.valid_timezone(zone))
        self.assertEqual(host.timestamp("2026-01-01T05:45:00+05:45"), host.timestamp("2026-01-01T00:00:00Z"))
        for value in ["2026-01-01T00:00:00", "2026-02-30T00:00:00Z", "2026-01-01T00:00:00+00:99", "2026-01-01"]:
            with self.assertRaises(host.Failure):
                host.timestamp(value)

    def test_schedule_metadata_is_normalized_without_inferring_from_job_timestamps(self):
        payload = job(schedule_path="f/tests/nightly", timezone="Europe/Paris")
        now = datetime.datetime.now(datetime.timezone.utc)
        self.assertNotIn("timezone", host.runs([payload], "fixture", now)[0])
        with patch.object(host, "get_json", return_value=[{"path": "f/tests/nightly", "timezone": "Asia/Kathmandu", "args": {"private": True}}]) as get:
            zones = host.schedule_timezones("https://fixture.example", "synthetic", "fixture", [payload])
        self.assertIn("/schedules/list?", get.call_args.args[2])
        normalized = host.runs([payload], "fixture", now, zones)[0]
        self.assertEqual(normalized["timezone"], "Asia/Kathmandu")
        self.assertNotIn("args", normalized)
        for value in ["Bad/Zone", None, 1]:
            with patch.object(host, "get_json", return_value={"path": "f/tests/nightly", "timezone": value}):
                self.assertEqual(host.schedule_timezones("https://fixture.example", "synthetic", "fixture", [payload], exact=True), {})

    def test_optional_metadata_errors_preserve_inspection(self):
        payload = job(schedule_path="f/tests/nightly", args={"at": "2026-01-01T00:00:00Z"})
        for code in ["deleted", "forbidden", "authentication_expired", "network_failure", "response_invalid"]:
            with patch.object(host, "get_json", side_effect=[payload, host.Failure(code), "logs"]):
                detail = host.inspection("https://fixture.example", "synthetic", "fixture", payload["id"])["detail"]
            self.assertNotIn("timezone", detail["run"])
            self.assertIn("2026-01-01T00:00:00Z", detail["inputs"]["text"])
            self.assertEqual(detail["logs"]["text"], "logs")
        for path in ["../private", "f/../private", {}, None]:
            with patch.object(host, "get_json") as get:
                self.assertEqual(host.schedule_timezones("https://fixture.example", "synthetic", "fixture", [job(schedule_path=path)], exact=True), {})
                get.assert_not_called()

    def test_exact_schedule_identity_and_pagination(self):
        payload = job(schedule_path="f/tests/nightly")
        with patch.object(host, "get_json", return_value={"path": "f/other", "timezone": "UTC"}):
            self.assertEqual(host.schedule_timezones("https://fixture.example", "synthetic", "fixture", [payload], exact=True), {})
        first = [{"path": f"f/other/{index}", "timezone": "UTC"} for index in range(100)]
        with patch.object(host, "get_json", side_effect=[first, [{"path": "f/tests/nightly", "timezone": "Asia/Tokyo"}]]) as get:
            self.assertEqual(host.schedule_timezones("https://fixture.example", "synthetic", "fixture", [payload]), {"f/tests/nightly": "Asia/Tokyo"})
            self.assertTrue(get.call_args.args[2].endswith("page=1"))
        with patch.object(host, "get_json", return_value=first):
            self.assertEqual(host.schedule_timezones("https://fixture.example", "synthetic", "fixture", [payload]), {})
