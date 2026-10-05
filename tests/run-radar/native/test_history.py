import unittest
from unittest.mock import patch
from test_host import host, job


class HistoryTests(unittest.TestCase):
    def test_script_versions_equal_paths_and_raw_coverage(self):
        flow = {"path": "f/tests/shared", "summary": "Flow"}
        scripts = [{"path": "f/tests/shared", "summary": "Latest", "archived": False}] * 100
        with patch.object(host, "credentials", return_value=("https://fixture.example", "synthetic-test-key")), patch.object(host, "get_json", side_effect=[[flow], scripts]) as get:
            result = host.handle(self.request("flows"), "unused")
        self.assertTrue(result["hasMore"])
        self.assertEqual([item["kind"] for item in result["flows"]], ["flow", "script"])
        self.assertIn("/scripts/list?", get.call_args.args[2])
        self.assertIn("show_archived=false", get.call_args.args[2])
        self.assertIn("include_without_main=true", get.call_args.args[2])
        self.assertNotIn("show_all_versions", get.call_args.args[2])

    def test_script_history_and_unknown_execution_metadata(self):
        for page in (1, 2):
            result, url = self.handle(self.request(page=page, flowKind="script"), [job(job_kind="script")])
            self.assertEqual(result["flowKind"], "script")
            self.assertEqual(result["runs"][0]["jobKind"], "script")
            self.assertIn("job_kinds=script", url)
        result, _ = self.handle(self.request(flowPath=None, flowKind=None), [job(job_kind="preview")])
        self.assertEqual(result["runs"][0]["jobKind"], "preview")
        for kind in (3, "", "a\n", "a" * 51):
            with self.assertRaises(host.Failure):
                self.handle(self.request(flowPath=None, flowKind=None), [job(job_kind=kind)])
        with self.assertRaises(host.Failure):
            self.handle(self.request(flowKind="script"), [job(job_kind="flow")])

    def test_malformed_script_catalog_and_history_kind(self):
        for row in ({"path": "f/test", "archived": True}, {"path": "f/test", "archived": "false"}, {"path": "f/test", "summary": 3}):
            with patch.object(host, "get_json", side_effect=[[], [row]]), self.assertRaises(host.Failure):
                host.browse("https://fixture.example", "synthetic-test-key", self.request("flows"))
        with patch.object(host, "credentials") as credentials:
            for fields in ({"flowKind": "preview"}, {"flowKind": None}, {"flowPath": None}, {"flowPath": None, "flowKind": "script"}):
                with self.assertRaises(host.Failure):
                    host.handle(self.request(**fields), "unused")
            credentials.assert_not_called()

    def request(self, op="history", **fields):
        return {"op": op, "instance": "https://fixture.example", "workspace": "fixture", "page": 1, **({"flowPath": "f/tests/run", "flowKind": "flow"} if op == "history" else {}), **fields}

    def handle(self, message, rows):
        with patch.object(host, "credentials", return_value=("https://fixture.example", "synthetic-test-key")), patch.object(host, "get_json", side_effect=lambda _instance, _token, url: [] if "/scripts/list" in url else rows) as get:
            result = host.handle(message, "unused")
            return result, get.call_args_list[0].args[2]

    def test_exact_flow_filter_and_one_based_pages(self):
        for page in (1, 2):
            result, url = self.handle(self.request(page=page), [job(job_kind="flow")])
            self.assertEqual(result["page"], page)
            self.assertEqual(result["flowPath"], "f/tests/run")
            self.assertFalse(result["hasMore"])
            self.assertIn("script_path_exact=f%2Ftests%2Frun", url)
            self.assertIn("job_kinds=flow", url)
            self.assertIn("page=" + str(page), url)
            self.assertIn("/jobs/list?" if page == 1 else "/jobs/completed/list?", url)
        result, url = self.handle(self.request(flowPath=None, flowKind=None), [])
        self.assertEqual(result["runs"], [])
        self.assertNotIn("script_path_exact", url)

    def test_catalog_bounds_sanitization_and_malformed_results(self):
        result, url = self.handle(self.request("flows", page=2), [{"path": "f/tests/old", "summary": "Old payroll", "private": "removed"}])
        self.assertEqual(result["flows"], [{"path": "f/tests/old", "summary": "Old payroll", "kind": "flow"}])
        self.assertIn("/flows/list?", url)
        for rows in ([{"path": "f/tests/old"}] * 101, [{"path": "f/tests/old"}] * 2, [{"path": "!bad"}], [{"path": "f/tests/old", "workspace_id": "foreign"}], [{"path": "f/tests/old", "summary": False}]):
            with self.assertRaises(host.Failure):
                self.handle(self.request("flows"), rows)

    def test_rejects_invalid_requests_before_credentials(self):
        with patch.object(host, "credentials") as credentials:
            for fields in ({"page": 0}, {"page": True}, {"page": 10001}, {"flowPath": "!bad"}, {"flowPath": "a,b"}, {"workspace": "../bad"}, {"extra": "bad"}):
                with self.assertRaises(host.Failure):
                    host.handle(self.request(**fields), "unused")
            credentials.assert_not_called()

    def test_bounds_history_and_rejects_foreign_child_and_active_older_runs(self):
        for rows in ([job(job_kind="flow", script_path="f/tests/foreign")], [job(job_kind="flow", workspace_id="foreign")], [job(job_kind="flow", parent_job="parent")], [job(job_kind="flow", kind="QueuedJob")], [job(i + 1, job_kind="flow") for i in range(101)]):
            with self.assertRaises(host.Failure):
                self.handle(self.request(page=2), rows)
        result, _ = self.handle(self.request(), [job(i + 1, job_kind="flow") for i in range(100)])
        self.assertTrue(result["hasMore"])
