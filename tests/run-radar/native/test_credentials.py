import errno
import fcntl
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
from unittest.mock import patch
from test_host import host, ROOT, EXTENSION


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="run-radar-fifo-race-")
        self.fifo = Path(self.directory.name) / "synthetic.fifo"
        os.mkfifo(self.fifo, 0o600)
        self.payload = b"WMILL_URL=https://fixture.example\nWMILL_API_KEY=synthetic-only\n"

    def tearDown(self):
        self.directory.cleanup()

    def test_competing_read_between_select_and_read_is_not_helper_failure(self):
        real_read, real_select = os.read, select.select
        competitor = os.open(self.fifo, os.O_RDONLY | os.O_NONBLOCK)
        writer = os.open(self.fifo, os.O_WRONLY | os.O_NONBLOCK)
        os.write(writer, self.payload)
        drained, errors = [], []
        def ready(*args):
            result = real_select(*args)
            if result[0] and not drained:
                drained.append(real_read(competitor, 4096))
            return result
        def read(fd, size):
            try:
                return real_read(fd, size)
            except BlockingIOError as error:
                errors.append(error.errno)
                os.write(writer, self.payload)
                os.close(writer)
                raise
        try:
            with patch.object(host.select, "select", ready), patch.object(host.os, "read", read):
                self.assertEqual(host.credentials(self.fifo, timeout=0.3), ("https://fixture.example", "synthetic-only"))
            self.assertEqual(drained, [self.payload])
            self.assertEqual(errors, [errno.EAGAIN])
        finally:
            os.close(competitor)
            if not errors:
                os.close(writer)

    def test_fifo_read_holds_a_process_lock_until_eof(self):
        real_read = os.read
        observations = []
        reader = os.open(self.fifo, os.O_RDONLY | os.O_NONBLOCK)
        writer = os.open(self.fifo, os.O_WRONLY | os.O_NONBLOCK)
        os.write(writer, self.payload)
        os.close(writer)
        def read(fd, size):
            lock = os.open(str(self.fifo) + ".run-radar.lock", os.O_CREAT | os.O_RDWR, 0o600)
            try:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    observations.append("held")
                else:
                    observations.append("unlocked")
            finally:
                os.close(lock)
            return real_read(fd, size)
        try:
            with patch.object(host.os, "read", read):
                self.assertEqual(host.credentials(self.fifo), ("https://fixture.example", "synthetic-only"))
            self.assertEqual(observations, ["held", "held"])
            self.assertEqual(Path(str(self.fifo) + ".run-radar.lock").stat().st_size, 0)
        finally:
            os.close(reader)

    def test_contended_process_lock_uses_the_credential_deadline(self):
        lock = os.open(str(self.fifo) + ".run-radar.lock", os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        start = time.monotonic()
        try:
            with self.assertRaisesRegex(host.Failure, "fifo_locked_or_stalled"):
                host.credentials(self.fifo, timeout=0.08)
            self.assertLess(time.monotonic() - start, 0.3)
        finally:
            os.close(lock)

    def test_lock_symlink_nonregular_and_permissions_are_rejected(self):
        lock = Path(str(self.fifo) + ".run-radar.lock")
        target = Path(self.directory.name) / "target"
        target.write_text("synthetic-only")
        lock.symlink_to(target)
        with self.assertRaisesRegex(host.Failure, "fifo_permissions"):
            host.credentials(self.fifo)
        self.assertEqual(target.read_text(), "synthetic-only")
        lock.unlink()
        os.mkfifo(lock, 0o600)
        with self.assertRaisesRegex(host.Failure, "fifo_permissions"):
            host.credentials(self.fifo)
        lock.unlink()
        lock.touch(mode=0o644)
        with self.assertRaisesRegex(host.Failure, "fifo_permissions"):
            host.credentials(self.fifo)
        lock.chmod(0o600)
        lock.write_text("synthetic-only")
        with self.assertRaisesRegex(host.Failure, "fifo_permissions"):
            host.credentials(self.fifo)
        lock.write_bytes(b"")
        alias = Path(self.directory.name) / "alias"
        os.link(lock, alias)
        with self.assertRaisesRegex(host.Failure, "fifo_permissions"):
            host.credentials(self.fifo)

    def start_host(self, observe_lock=False):
        command = [sys.executable, str(ROOT / "native/host.py"), str(self.fifo), EXTENSION,
                   "chrome-extension://" + EXTENSION + "/"]
        if observe_lock:
            script = """import logging, sys
from test_host import host
original = host.fcntl.flock
def observe(fd, operation):
    try:
        original(fd, operation)
    except BlockingIOError:
        logging.error('{"event":"credential_lock_waiting"}')
        raise
    else:
        logging.error('{"event":"credential_lock_acquired"}')
host.fcntl.flock = observe
raise SystemExit(host.serve(sys.argv[1], sys.argv[2], sys.argv[3]))
"""
            command = [sys.executable, "-c", script, str(self.fifo), EXTENSION,
                       "chrome-extension://" + EXTENSION + "/"]
        process = subprocess.Popen(command, cwd=ROOT / "tests/run-radar/native",
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.close_host, process)
        data = json.dumps({"op": "status"}).encode()
        process.stdin.write(struct.pack("=I", len(data)) + data)
        process.stdin.flush()
        return process

    def close_host(self, process):
        if process.poll() is None:
            process.kill()
        process.wait(timeout=2)
        for stream in (process.stdin, process.stdout, process.stderr):
            stream.close()

    def response(self, process):
        self.assertTrue(select.select([process.stdout], [], [], 3)[0])
        length = struct.unpack("=I", process.stdout.read(4))[0]
        return json.loads(process.stdout.read(length))

    def test_concurrent_native_processes_receive_complete_fifo_sessions(self):
        processes = [self.start_host() for _ in range(4)]
        stop = threading.Event()
        served = []
        def writer():
            while not stop.is_set():
                try:
                    fd = os.open(self.fifo, os.O_WRONLY | os.O_NONBLOCK)
                except OSError as error:
                    if error.errno != errno.ENXIO:
                        served.append(error)
                        return
                    stop.wait(0.001)
                    continue
                try:
                    os.write(fd, self.payload)
                    served.append("complete")
                except BrokenPipeError:
                    continue
                finally:
                    os.close(fd)
                stop.wait(0.001)
        thread = threading.Thread(target=writer)
        thread.start()
        try:
            for process in processes:
                self.assertEqual(self.response(process), {"ok": True, "instance": "https://fixture.example", "helper": "installed"})
                process.stdin.close()
                self.assertEqual(process.wait(timeout=1), 0)
                self.assertEqual(process.stderr.read(), b"")
            self.assertGreaterEqual(served.count("complete"), 4)
            self.assertTrue(all(item == "complete" for item in served))
        finally:
            stop.set()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())

    def test_eof_cancels_a_native_process_waiting_for_the_lock(self):
        lock = os.open(str(self.fifo) + ".run-radar.lock", os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            process = self.start_host(observe_lock=True)
            self.assertTrue(select.select([process.stderr], [], [], 2)[0])
            self.assertIn(b'"credential_lock_waiting"', process.stderr.readline())
            process.stdin.close()
            self.assertEqual(process.wait(timeout=1), 0)
            self.assertNotIn(b"native_internal_error", process.stderr.read())
        finally:
            os.close(lock)
        owner = self.start_host(observe_lock=True)
        self.assertTrue(select.select([owner.stderr], [], [], 2)[0])
        self.assertIn(b'"credential_lock_acquired"', owner.stderr.readline())
        owner.stdin.close()
        self.assertEqual(owner.wait(timeout=1), 0)
        next_process = self.start_host()
        writer = threading.Thread(target=self.write_once)
        writer.start()
        try:
            self.assertEqual(self.response(next_process)["helper"], "installed")
        finally:
            next_process.stdin.close()
            writer.join(timeout=2)
            self.assertFalse(writer.is_alive())

    def write_once(self):
        with self.fifo.open("wb", buffering=0) as stream:
            stream.write(self.payload)


if __name__ == "__main__":
    unittest.main()
