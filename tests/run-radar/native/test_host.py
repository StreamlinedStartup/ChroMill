import datetime
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("host", ROOT / "native/host.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
spec_install = importlib.util.spec_from_file_location("installer", ROOT / "native/install.py")
installer = importlib.util.module_from_spec(spec_install)
spec_install.loader.exec_module(installer)
EXTENSION = "a" * 32
NOW = datetime.datetime.now(datetime.timezone.utc)


def job(index=1, kind="CompletedJob", **fields):
    return {"id": f"00000000-0000-0000-0000-{index:012d}", "workspace_id": "fixture",
            "type": kind, "is_flow_step": False, "canceled": False, "running": False,
            "success": True, "duration_ms": 250, "script_path": "f/tests/run",
            "created_at": "2026-01-01T00:00:00Z", "trigger_kind": "webhook", **fields}


class Fixture(http.server.BaseHTTPRequestHandler):
    status = 200
    body = []
    requests = []

    def do_GET(self):
        self.requests.append((self.command, self.path, self.headers.get("Authorization") == "Bearer synthetic-test-credential"))
        self.send_response(self.status)
        if self.status == 302:
            self.send_header("Location", "http://127.0.0.1:1/never")
        self.end_headers()
        payload = self.body if isinstance(self.body, bytes) else json.dumps(self.body).encode()
        self.wfile.write(payload)

    def log_message(self, *_args):
        pass  # Fixture diagnostics do not include request paths or credentials.


class HostTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="run-radar-synthetic-")
        self.fifo = Path(self.directory.name) / "synthetic.fifo"
        os.mkfifo(self.fifo, 0o600)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.instance = f"http://127.0.0.1:{self.server.server_port}"
        Fixture.status, Fixture.body, Fixture.requests = 200, [], []

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.directory.cleanup()

    def writer(self, data=None):
        data = data if data is not None else f"WMILL_URL={self.instance}\nWMILL_API_KEY=synthetic-test-credential\n"
        def write():
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                try:
                    fd = os.open(self.fifo, os.O_WRONLY | os.O_NONBLOCK)
                    try:
                        os.write(fd, data.encode())
                    except BrokenPipeError:
                        pass
                    finally:
                        os.close(fd)
                    return
                except OSError:
                    time.sleep(0.01)
        thread = threading.Thread(target=write, daemon=True)
        thread.start()
        return thread

    def request(self, message, data=None):
        self.writer(data)
        return host.handle(message, self.fifo)

    def test_fifo_metadata_missing_variables_and_deadline(self):
        self.assertEqual(self.request({"op": "status"})["instance"], self.instance)
        self.assertEqual(os.stat(self.fifo).st_size, 0)
        with self.assertRaisesRegex(host.Failure, "variables_missing"):
            self.request({"op": "status"}, "WMILL_URL=http://localhost\n")
        start = time.monotonic()
        with self.assertRaisesRegex(host.Failure, "fifo_locked_or_stalled"):
            host.credentials(self.fifo, timeout=0.08)
        self.assertLess(time.monotonic() - start, 0.2)
        os.chmod(self.fifo, 0o644)
        with self.assertRaisesRegex(host.Failure, "fifo_permissions"):
            host.credentials(self.fifo)
        self.fifo.unlink()
        with self.assertRaisesRegex(host.Failure, "fifo_missing"):
            host.credentials(self.fifo)
        self.fifo.write_text("synthetic-only")
        with self.assertRaisesRegex(host.Failure, "fifo_permissions"):
            host.credentials(self.fifo)

    def test_configured_origin_only(self):
        for url in ["https://user:password@example.org", "http://example.org", "https://example.org/api", "https://example.org?url=evil"]:
            with self.subTest(url=url), self.assertRaises(host.Failure):
                self.request({"op": "status"}, f"WMILL_URL={url}\nWMILL_API_KEY=synthetic-test-credential\n")

    def test_named_operations_and_ids(self):
        for message in [{"op": "delete"}, {"op": "recent", "workspace": "../admin"}, {"op": "recent", "workspace": "fixture", "url": "https://evil"}, {"op": "status", "id": "invalid"}, []]:
            with self.subTest(message=message), self.assertRaisesRegex(host.Failure, "request_invalid"):
                host.handle(message, self.fifo)
        self.assertEqual(Fixture.requests, [])

    def test_workspace_requests_reject_a_changed_instance_before_http(self):
        for op in ["workspaces", "recent"]:
            message = {"op": op, "instance": "https://other.example"}
            if op == "recent":
                message["workspace"] = "fixture"
            with self.subTest(op=op), self.assertRaisesRegex(host.Failure, "request_invalid"):
                self.request(message)
        self.assertEqual(Fixture.requests, [])
        Fixture.body = [job(workspace_id="second")]
        response = self.request({"op": "recent", "instance": self.instance, "workspace": "second"})
        self.assertEqual(response["workspace"], "second")
        Fixture.status = 403
        with self.assertRaisesRegex(host.Failure, "access_denied"):
            self.request({"op": "recent", "instance": self.instance, "workspace": "second"})
        self.assertTrue(all(method == "GET" and authenticated for method, _, authenticated in Fixture.requests))

    def test_workspaces_and_recent_jobs_are_minimized(self):
        Fixture.body = [{"id": "fixture", "name": "Synthetic workspace"}]
        self.assertEqual(self.request({"op": "workspaces"})["workspaces"], ["fixture"])
        Fixture.body = [job(1), job(2, success=False), job(3, kind="QueuedJob", running=True),
                        job(4, kind="QueuedJob"), job(5, canceled=True), job(6, parent_job="child"), job(7, is_skipped=True)]
        response = self.request({"op": "recent", "workspace": "fixture"})
        self.assertEqual([r["status"] for r in response["runs"]], ["success", "failed", "running", "queued", "canceled", "skipped"])
        self.assertTrue(all(method == "GET" and authenticated for method, _, authenticated in Fixture.requests))
        self.assertIn("has_null_parent=true", Fixture.requests[-1][1])
        self.assertNotIn("synthetic-test-credential", json.dumps(response))
        self.assertNotIn("args", json.dumps(response))

    def test_errors_empty_and_malformed(self):
        for status, code in [(401, "authentication_expired"), (403, "access_denied"), (404, "access_denied"), (500, "server_error"), (302, "redirect_rejected")]:
            Fixture.status = status
            with self.subTest(status=status), self.assertRaisesRegex(host.Failure, code):
                self.request({"op": "workspaces"})
        Fixture.status = 200
        Fixture.body = []
        self.assertEqual(self.request({"op": "recent", "workspace": "fixture"})["runs"], [])
        for payload in [b"invalid json", b"synthetic-test-credential", b"x" * (host.MAX_RESPONSE + 1), {"unexpected": True}, [{"id": "../invalid"}]]:
            Fixture.body = payload
            with self.subTest(kind=type(payload).__name__), self.assertRaises(host.Failure):
                self.request({"op": "workspaces"})
        Fixture.body = b'[{"id":"\\u0073ynthetic-test-credential"}]'
        with self.assertRaisesRegex(host.Failure, "credential_echo"):
            self.request({"op": "workspaces"})

    def test_invalid_run_states_and_cross_workspace(self):
        for payload in [[job(success="true")], [job(id="invalid")], [job(workspace_id="other")], [job(duration_ms=-1)], [job(), job()], [job(type="unknown")], [job(created_at="invalid")]]:
            with self.subTest(payload=payload), self.assertRaisesRegex(host.Failure, "response_invalid"):
                host.runs(payload, "fixture", NOW)

    def test_server_adds_queue_to_completed_page_size(self):
        payload = [job(index) for index in range(1, 114)]
        self.assertEqual(len(host.runs(payload, "fixture", NOW)), 100)
        with self.assertRaisesRegex(host.Failure, "response_invalid"):
            host.runs([job(index) for index in range(1, 1002)], "fixture", NOW)

    def test_network_failure(self):
        with self.assertRaisesRegex(host.Failure, "network_failure"):
            host.get_json("http://127.0.0.1:1", "synthetic-test-credential", "/api/workspaces/list")

    def start_host(self, origin=None):
        return subprocess.Popen([sys.executable, str(ROOT / "native/host.py"), str(self.fifo), EXTENSION,
                                 origin or "chrome-extension://" + EXTENSION + "/"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def close_host(self, process):
        try:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=2)
        finally:
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()

    def test_cleanup_reaps_host_after_failed_assertion(self):
        process = self.start_host()
        try:
            with self.assertRaises(AssertionError):
                try:
                    self.fail("Injected assertion failure")
                finally:
                    self.close_host(process)
            self.assertIsNotNone(process.returncode)
            self.assertTrue(all(stream.closed for stream in (process.stdin, process.stdout, process.stderr)))
        finally:
            self.close_host(process)

    def test_native_framed_round_trip_and_eof_cancels_stalled_read(self):
        process = self.start_host()
        try:
            self.writer()
            data = json.dumps({"op": "status"}).encode()
            process.stdin.write(struct.pack("=I", len(data)) + data)
            process.stdin.flush()
            self.assertTrue(select.select([process.stdout], [], [], 3)[0])
            length = struct.unpack("=I", process.stdout.read(4))[0]
            response = json.loads(process.stdout.read(length))
            self.assertEqual(response["helper"], "installed")
            self.assertNotIn("synthetic-test-credential", json.dumps(response))
            process.stdin.write(struct.pack("=I", len(data)) + data)
            process.stdin.flush()
            process.stdin.close()
            self.assertEqual(process.wait(timeout=1), 0)
            self.assertEqual(process.stderr.read(), b"")
        finally:
            self.close_host(process)

    def test_bad_origin_oversized_and_truncated_frames(self):
        process = self.start_host("chrome-extension://" + "b" * 32 + "/")
        try:
            self.assertEqual(process.wait(timeout=1), 1)
        finally:
            self.close_host(process)
        for body in [struct.pack("=I", host.MAX_FRAME + 1), struct.pack("=I", 3) + b"{", struct.pack("=I", 1) + b"x"]:
            process = self.start_host()
            try:
                output, errors = process.communicate(body, timeout=2)
                self.assertEqual(process.returncode, 1)
                self.assertEqual(output, b"")
                self.assertIn(b"native_protocol_rejected", errors)
            finally:
                self.close_host(process)
        with self.assertRaisesRegex(host.Failure, "frame_truncated"):
            host.read_exact(io.BytesIO(b"a"), 4)

    def test_installer_exact_origin_and_no_fifo_changes(self):
        directory = Path(self.directory.name) / "registration"
        installer.install(directory, EXTENSION, self.fifo)
        manifest = json.loads((directory / (host.NAME + ".json")).read_text())
        self.assertEqual(manifest["allowed_origins"], ["chrome-extension://" + EXTENSION + "/"])
        self.assertEqual(os.stat(self.fifo).st_size, 0)
        with self.assertRaises(ValueError):
            installer.install(directory, EXTENSION, self.fifo)
        with self.assertRaises(ValueError):
            installer.install(directory, "*", self.fifo)


if __name__ == "__main__":
    unittest.main()
