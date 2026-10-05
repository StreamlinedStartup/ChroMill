import unittest
import http.server
import json
import threading
from unittest.mock import patch
from test_host import host, job


def execution(index, minute=1, **fields):
    return job(index, **{"job_kind": "script", "started_at": f"2026-01-01T00:{minute:02d}:00Z",
                        "is_skipped": False, "script_hash": "abc1", **fields})


class ComparisonTests(unittest.TestCase):
    def compare(self, selected, history, baseline=None):
        replies = [selected, history]
        if baseline:
            replies += [baseline, "selected logs", "baseline logs"]
        with patch.object(host, "get_json", side_effect=replies) as get:
            response = host.comparison("https://fixture.example", "synthetic-only", "fixture", selected["id"])
        return response, get

    def test_start_order_ties_inputs_and_script_version(self):
        selected = execution(9, 5, success=False, args={"added": 2}, result=None)
        baseline = execution(3, 3, args={"removed": 1}, result={"ok": True})
        response, get = self.compare(selected, [execution(1, 1), execution(2, 3), baseline, execution(4, 5)], baseline)
        self.assertEqual(response["state"], "available")
        self.assertEqual(response["baseline"]["detail"]["run"]["id"], baseline["id"])
        self.assertEqual(response["selected"]["version"]["text"], "abc1")
        self.assertIn("added", response["selected"]["detail"]["inputs"]["text"])
        self.assertIn("script_path_exact=", get.call_args_list[1].args[2])
        self.assertIn("is_skipped=false", get.call_args_list[1].args[2])

    def test_no_baseline_and_metadata_states(self):
        self.assertEqual(self.compare(execution(9, 5), [execution(2, 5)])[0]["state"], "no_baseline")
        for selected, state in [(job(9, job_kind="preview"), "incompatible_type"), (job(9, job_kind="script"), "missing_metadata"),
                                (execution(9, 5, script_path="!unsafe"), "unsupported_path")]:
            self.assertEqual(self.compare(selected, [])[0]["state"], state)

    def test_search_exhaustion_and_duplicate_history_are_not_no_baseline(self):
        selected = execution(999, 5)
        pages = [[execution(page * 100 + i, 1) for i in range(1, 101)] for page in range(5)]
        with patch.object(host, "get_json", side_effect=[selected, *pages]):
            response = host.comparison("https://fixture.example", "synthetic-only", "fixture", selected["id"])
        self.assertEqual(response["state"], "search_limit")
        self.assertEqual(response["searched"], 500)
        response, _ = self.compare(selected, [execution(1), execution(1)])
        self.assertEqual(response["state"], "search_limit")
        with patch.object(host, "get_json", side_effect=[selected, pages[0], [], pages[0][-1], "", ""]):
            response = host.comparison("https://fixture.example", "synthetic-only", "fixture", selected["id"])
        self.assertEqual(response["state"], "available")

    def test_untrusted_scope_and_ineligible_history_are_rejected(self):
        for fields in [{"workspace_id": "other"}, {"script_path": "f/other"}, {"job_kind": "flow"},
                       {"parent_job": "child"}, {"is_flow_step": True}, {"success": False},
                       {"canceled": True}, {"is_skipped": True}, {"type": "QueuedJob"}]:
            with self.subTest(fields=fields), self.assertRaisesRegex(host.Failure, "response_invalid"):
                self.compare(execution(9, 5), [execution(1, **fields)])
        with self.assertRaisesRegex(host.Failure, "response_invalid"):
            self.compare(execution(9, 5), [execution(1)], execution(1, workspace_id="other"))

    def test_forbidden_missing_large_and_flow_versions(self):
        selected = execution(9, 5)
        for code in ["forbidden", "deleted"]:
            with patch.object(host, "get_json", side_effect=[selected, [execution(1)], host.Failure(code)]):
                response = host.comparison("https://fixture.example", "synthetic-only", "fixture", selected["id"])
            self.assertEqual(response["state"], "baseline_" + code)
        selected["job_kind"] = "flow"
        selected.pop("script_hash")
        baseline = execution(1, args={"large": "x" * 40000})
        baseline["job_kind"] = "flow"
        baseline.pop("script_hash")
        response, _ = self.compare(selected, [baseline], baseline)
        self.assertEqual(response["baseline"]["version"], {"state": "unavailable"})
        self.assertTrue(response["baseline"]["detail"]["inputs"]["truncated"])

    def test_compare_authorizes_exact_instance_and_request_shape(self):
        with patch.object(host, "credentials", return_value=("https://fixture.example", "synthetic-only")), patch.object(host, "get_json") as get:
            with self.assertRaisesRegex(host.Failure, "request_invalid"):
                host.handle({"op": "compare", "workspace": "fixture", "runId": execution(1)["id"], "instance": "https://other.example"}, "unused")
            get.assert_not_called()

    def test_large_result_placeholder_does_not_claim_equality(self):
        response, _ = self.compare(execution(9, 5, result="WINDMILL_TOO_BIG"), [execution(1)], execution(1))
        self.assertEqual(response["selected"]["detail"]["result"], {"state": "response_too_large"})

    def test_microsecond_start_order_is_preserved_on_the_wire(self):
        selected = execution(9, started_at="2026-01-01T00:01:00.000002Z")
        baseline = execution(1, started_at="2026-01-01T00:01:00.000001Z")
        response, _ = self.compare(selected, [baseline], baseline)
        self.assertEqual(response["selected"]["detail"]["run"]["startedAt"], selected["started_at"])
        self.assertEqual(response["baseline"]["detail"]["run"]["startedAt"], baseline["started_at"])

    def test_raw_http_decimal_tokens_survive_nested_inputs_and_results(self):
        for token in ["1.00000000000000001", "-1.00000000000000001", "1e-400", "1e400", "0.1", "1.0", "2.5e2"]:
            with self.subTest(token=token):
                baseline = execution(1, args={"nested": ["RAW_NUMBER"]}, result=[{"value": "RAW_NUMBER"}])
                selected = execution(9, 5, success=False, args=baseline["args"], result=baseline["result"])
                class Fixture(http.server.BaseHTTPRequestHandler):
                    def do_GET(self):
                        self.send_response(200)
                        self.end_headers()
                        if "/get_logs/" in self.path:
                            body = "fixture logs"
                        elif "/completed/list" in self.path:
                            body = json.dumps([baseline]).replace('"RAW_NUMBER"', "1.0")
                        else:
                            chosen = selected if self.path.endswith(selected["id"]) else baseline
                            body = json.dumps(chosen).replace('"RAW_NUMBER"', token if chosen is selected else "1.0")
                        self.wfile.write(body.encode())
                    def log_message(self, *_args):
                        pass
                server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    response = host.comparison(f"http://127.0.0.1:{server.server_port}", "synthetic-only", "fixture", selected["id"])
                    for name in ["inputs", "result"]:
                        self.assertIn(token, response["selected"]["detail"][name]["text"])
                        self.assertIn("1.0", response["baseline"]["detail"][name]["text"])
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join()
