import json
import unittest
from unittest.mock import patch
from test_host import host, job

class InspectionTests(unittest.TestCase):
    def test_native_wire_size_and_invalid_unicode_are_explicit(self):
        self.assertEqual(json.loads(host.encode_response({"text": "x" * host.MAX_NATIVE_RESPONSE})),
                         {"ok": False, "code": "response_too_large"})
        self.assertEqual(json.loads(host.encode_response({"text": "\ud800"})),
                         {"ok": False, "code": "response_invalid"})

    def test_named_detail_full_logs_and_fields(self):
        payload = job(job_kind="flow", args={"input": "<script>bad()</script>"}, result=None, flow_status={"modules": [{"id": "step-a"}]})
        with patch.object(host, "get_json", side_effect=[payload, "old\nfinal"] ) as get:
            response = host.inspection("https://fixture.example", "synthetic-only", "fixture", payload["id"])
        self.assertEqual(response["detail"]["logs"], {"state": "available", "text": "old\nfinal", "truncated": False})
        self.assertEqual(response["detail"]["result"]["text"], "null")
        self.assertIn("<script>", response["detail"]["inputs"]["text"])
        self.assertIn("get_flow_all_logs/", get.call_args.args[2])

    def test_limits_and_unavailable_fields(self):
        payload = job(args={"big": "x" * 40000})
        with patch.object(host, "get_json", side_effect=[payload, "x" * 70000 + "final"]):
            detail = host.inspection("https://fixture.example", "synthetic-only", "fixture", payload["id"])["detail"]
        self.assertEqual(len(detail["logs"]["text"]), 64000)
        self.assertTrue(detail["logs"]["text"].endswith("final"))
        self.assertTrue(detail["logs"]["truncated"])
        self.assertTrue(detail["inputs"]["truncated"])
        self.assertEqual(detail["result"], {"state": "unavailable"})
        self.assertEqual(detail["steps"], {"state": "unavailable"})

    def test_identity_denial_and_partial_log_failure(self):
        payload = job()
        with patch.object(host, "get_json", return_value=job(workspace_id="other")), self.assertRaisesRegex(host.Failure, "response_invalid"):
            host.inspection("https://fixture.example", "synthetic-only", "fixture", payload["id"])
        for code in ["deleted", "forbidden", "response_too_large", "network_failure"]:
            with patch.object(host, "get_json", side_effect=[payload, host.Failure(code)]):
                detail = host.inspection("https://fixture.example", "synthetic-only", "fixture", payload["id"])["detail"]
            self.assertEqual(detail["logs"], {"state": code})
        with patch.object(host, "credentials", return_value=("https://fixture.example", "synthetic-only")), patch.object(host, "get_json") as get:
            for request in [{"op": "inspect", "workspace": "fixture", "runId": "../invalid", "instance": "https://fixture.example"},
                            {"op": "inspect", "workspace": "fixture", "runId": payload["id"], "instance": "https://other.example"}]:
                with self.assertRaisesRegex(host.Failure, "request_invalid"):
                    host.handle(request, "unused")
            get.assert_not_called()
