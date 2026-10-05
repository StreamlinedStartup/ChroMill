import io
import json
import unittest
from unittest.mock import patch
from test_host import host, job


class FollowTests(unittest.TestCase):
    def follow(self, offset, payload=None, logs="parté\n"):
        payload = payload or job(kind="QueuedJob", running=True, flow_status={"modules": [{"type": "InProgress"}]})
        request = {"op": "follow", "instance": "https://fixture.example", "workspace": "fixture", "runId": payload["id"], "offset": offset}
        with patch.object(host, "credentials", return_value=(request["instance"], "synthetic-only")), patch.object(host, "get_json", side_effect=[payload, logs]) as get:
            result = host.handle(request, "unused")
        self.assertTrue(all(call.args[2].startswith("/api/w/fixture/jobs_u/") for call in get.call_args_list))
        return result

    def test_reconnect_snapshots_replace_instead_of_append(self):
        first = self.follow(0)
        next_snapshot = self.follow(first["offsets"]["end"], logs="parté\nfinal")
        self.assertEqual(first["offsets"], {"start": 0, "end": 6})
        self.assertEqual(next_snapshot["detail"]["logs"]["text"], "parté\nfinal")
        self.assertEqual(next_snapshot["offsets"], {"start": 0, "end": 11})
        self.assertEqual(self.follow(11, logs="reset")["offsets"], {"start": 0, "end": 5})

    def test_completion_and_step_status(self):
        payload = job(result={"done": True}, flow_status={"modules": [{"type": "Success"}]})
        result = self.follow(4, payload)
        self.assertEqual(result["detail"]["run"]["status"], "success")
        self.assertIn('"done": true', result["detail"]["result"]["text"])
        self.assertIn('"Success"', result["detail"]["steps"]["text"])

    def test_unicode_limits_are_explicit(self):
        result = self.follow(0, logs="\U0001f600" * 64001)
        self.assertEqual(result["offsets"], {"start": 1, "end": 64001})
        self.assertTrue(result["detail"]["logs"]["truncated"])
        self.assertEqual(len(result["detail"]["logs"]["text"]), 64000)

    def test_fragmented_native_frames(self):
        class Fragmented(io.BytesIO):
            def read(self, size):
                return super().read(min(size, 1))
        body = json.dumps(self.follow(0), ensure_ascii=False).encode()
        self.assertEqual(host.read_exact(Fragmented(body), len(body)), body)
        with self.assertRaisesRegex(host.Failure, "frame_truncated"):
            host.read_exact(Fragmented(body[:-1]), len(body))

    def test_offsets_are_validated_before_credentials(self):
        with patch.object(host, "credentials") as credentials:
            for offset in [-1, True, "1", 2**54]:
                with self.assertRaisesRegex(host.Failure, "request_invalid"):
                    host.handle({"op": "follow", "instance": "https://fixture.example", "workspace": "fixture", "runId": job()["id"], "offset": offset}, "unused")
            credentials.assert_not_called()
