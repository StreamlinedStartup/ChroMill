import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HELPERS = Path(__file__).resolve().parents[3] / "tools/test-support"
sys.path.insert(0, str(HELPERS))
import helper_runtime as runtime


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), HELPERS / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dev = load("dev-smoke")
clean = load("clean-proof")
checks = load("run-checks")


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / "output"
        self.output.mkdir()

    def test_task_timeout_kills_descendant_and_records_failure(self):
        pid_file = self.root / "pid"
        code = ("import subprocess,time; p=subprocess.Popen(['sleep','60']); "
                "open(" + repr(str(pid_file)) + ",'w').write(str(p.pid)); time.sleep(60)")
        receipt = runtime.run([sys.executable, "-c", code], self.root, self.output / "log", .3)
        self.assertEqual(receipt["exitCode"], 124)
        self.assertTrue(receipt["timedOut"])
        pid = int(pid_file.read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_missing_tmux_fails_with_unrelated_server(self):
        with patch.dict(os.environ, {"TMUX": "", "TMUX_PANE": ""}), patch.object(runtime, "bounded_output") as lookup:
            with self.assertRaises(RuntimeError):
                runtime.tmux_context()
            lookup.assert_not_called()

    def test_tmux_targets_current_socket_and_pane(self):
        with patch.dict(os.environ, {"TMUX": "/tmp/test,123,0", "TMUX_PANE": "%8"}), patch.object(runtime, "bounded_output", return_value=subprocess.CompletedProcess([], 0, "%8|repair-tests\n")) as lookup:
            self.assertEqual(runtime.tmux_context()["tmuxSession"], "repair-tests")
            self.assertIn("%8", lookup.call_args.args[0])
            self.assertEqual(lookup.call_args.kwargs["timeout"], 5)

    def test_unrelated_pane_rejected(self):
        with patch.dict(os.environ, {"TMUX": "/tmp/test,123,0", "TMUX_PANE": "%8"}), patch.object(runtime, "bounded_output", return_value=subprocess.CompletedProcess([], 0, "%9|other\n")):
            with self.assertRaises(RuntimeError):
                runtime.tmux_context()

    def test_tmux_timeout_and_nonzero_propagate(self):
        for error in [subprocess.TimeoutExpired("tmux", 5), subprocess.CalledProcessError(1, "tmux")]:
            with patch.dict(os.environ, {"TMUX": "/tmp/test,123,0", "TMUX_PANE": "%8"}), patch.object(runtime, "bounded_output", side_effect=error):
                with self.assertRaises(type(error)):
                    runtime.tmux_context()

    def smoke(self, code, timeout=.5):
        actual_popen = subprocess.Popen
        def launch(*args, **kwargs):
            if args[0] == ["rtk", "proxy", "mise", "run", "dev"]:
                return actual_popen([sys.executable, "-c", code], **kwargs)
            return actual_popen(*args, **kwargs)
        with patch.object(dev, "tmux_context", return_value={"tmuxSession": "tests", "tmuxPane": "%1"}), patch.object(dev.subprocess, "Popen", side_effect=launch):
            return dev.smoke(self.root, self.output, timeout, .15)

    def ready_code(self):
        manifest = self.root / "build/chrome-mv3-dev/manifest.json"
        manifest.parent.mkdir(parents=True)
        manifest.write_text("{}")
        return "import signal,time,sys; signal.signal(signal.SIGINT,lambda *a: sys.exit(0)); print('Extension re-packaged',flush=True); time.sleep(60)"

    def test_dev_early_failure_is_nonzero(self):
        receipt = self.smoke("raise SystemExit(1)")
        self.assertFalse(receipt["ready"])
        self.assertEqual(receipt["exitCode"], 1)
        self.assertIn("before readiness", receipt["stopReason"])

    def test_dev_readiness_timeout_is_nonzero(self):
        receipt = self.smoke("import time; time.sleep(60)", .15)
        self.assertFalse(receipt["ready"])
        self.assertEqual(receipt["exitCode"], 1)
        self.assertIn("deadline", receipt["stopReason"])

    def test_dev_ready_and_intentional_shutdown(self):
        receipt = self.smoke(self.ready_code())
        self.assertTrue(receipt["ready"])
        self.assertEqual(receipt["exitCode"], 0)
        self.assertFalse(receipt["shutdownEscalated"])

    def test_dev_sigint_resistant_descendant_is_removed(self):
        pid = self.root / "descendant"
        code = self.ready_code().replace("signal.signal(signal.SIGINT,lambda *a: sys.exit(0))", "signal.signal(signal.SIGINT,signal.SIG_IGN)")
        code = code.replace("print('Extension", "import subprocess; p=subprocess.Popen(['sleep','60']); open(" + repr(str(pid)) + ",'w').write(str(p.pid)); print('Extension")
        receipt = self.smoke(code)
        self.assertEqual(receipt["exitCode"], 1)
        self.assertTrue(receipt["shutdownEscalated"])
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pid.read_text()), 0)

    def test_exception_during_readiness_cleans_process(self):
        with patch.object(Path, "read_text", side_effect=OSError("readiness read failed")):
            receipt = self.smoke(self.ready_code())
        self.assertEqual(receipt["exitCode"], 1)
        self.assertIn("readiness read failed", receipt["error"])
        self.assertIn("processExitCode", receipt)

    def fake_driver(self, suite_code=0, dev_code=0, ready=True, stale=False):
        def driver(command, root, output, timeout, cleanup_grace=2):
            child = Path(command[command.index("--output") + 1])
            child.mkdir(parents=True)
            is_suite = "run-checks.py" in command[3]
            value = {"runId": "old" if stale else "current", "exitCode": 0}
            if is_suite:
                value["commands"] = [{"command": ["mise", "run", task], "exitCode": 0} for task in clean.TASKS]
            else:
                value["ready"] = ready
            runtime.write(child / ("commands.json" if is_suite else "dev-receipt.json"), value)
            return {"exitCode": suite_code if is_suite else dev_code, "timeoutSeconds": timeout}
        return driver

    def proof(self, **kwargs):
        sandbox = self.root / "clean"
        sandbox.mkdir()
        with patch.object(clean, "tmux_context", return_value={"tmuxSession": "tests"}), patch.object(clean, "run", side_effect=self.fake_driver(**kwargs)):
            code = clean.prove(sandbox, self.output, "current", .5)
        return code, json.loads((self.output / "clean-receipt.json").read_text())

    def test_clean_suite_failure_propagates(self):
        code, receipt = self.proof(suite_code=1)
        self.assertEqual(code, 1)
        self.assertEqual(len(receipt["drivers"]), 1)

    def test_clean_dev_failure_rejects_ready_receipt(self):
        code, receipt = self.proof(dev_code=1)
        self.assertEqual(code, 1)
        self.assertIn("dev driver failed", receipt["error"])

    def test_clean_rejects_unready_receipt(self):
        self.assertEqual(self.proof(ready=False)[0], 1)

    def test_clean_rejects_stale_receipt(self):
        self.assertEqual(self.proof(stale=True)[0], 1)

    def test_clean_success_requires_both_fresh_children(self):
        code, receipt = self.proof()
        self.assertEqual(code, 0)
        self.assertTrue(receipt["dev"]["ready"])

    def test_clean_timeout_is_recorded_and_nonzero(self):
        sandbox = self.root / "clean"
        sandbox.mkdir()
        with patch.object(clean, "tmux_context", return_value={}), patch.object(clean, "run", return_value={"exitCode": 124, "timedOut": True}):
            self.assertEqual(clean.prove(sandbox, self.output, "current", .01), 1)
        self.assertTrue(json.loads((self.output / "clean-receipt.json").read_text())["drivers"][0]["timedOut"])

    def test_existing_evidence_is_never_reused(self):
        args = type("Args", (), {"output": self.output, "run_id": "current"})()
        with self.assertRaises(FileExistsError):
            runtime.output_directory(args)

    def test_checks_timeout_writes_final_failure_receipt(self):
        output = self.root / "checks"
        with patch.object(sys, "argv", ["run-checks.py", "--output", str(output), "test"]), patch.object(checks, "tmux_context", return_value={}), patch.object(checks, "run", return_value={"exitCode": 124, "timedOut": True}):
            self.assertEqual(checks.main(), 1)
        self.assertEqual(json.loads((output / "commands.json").read_text())["exitCode"], 1)

    def test_cleanup_exception_retains_dev_failure_receipt(self):
        with patch.object(dev, "stop_group", side_effect=OSError("cleanup failed")):
            receipt = self.smoke("raise SystemExit(1)")
        self.assertEqual(receipt["exitCode"], 1)
        self.assertEqual(receipt["cleanupError"], "cleanup failed")

    def test_nested_outer_timeout_cleans_separate_group_descendant(self):
        pid_file = self.root / "nested-pid"
        child = "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)"
        driver = self.root / "nested.py"
        driver.write_text("import sys,subprocess,signal,time\nsys.path.insert(0," + repr(str(HELPERS)) + ")\nimport helper_runtime as r\nsignal.signal(signal.SIGTERM,r.interrupted)\np=subprocess.Popen([sys.executable,'-c'," + repr(child) + "],start_new_session=True)\nopen(" + repr(str(pid_file)) + ",'w').write(str(p.pid))\ntry:\n time.sleep(60)\nfinally:\n r.stop_group(p,grace=.3)\n")
        receipt = runtime.run([sys.executable, str(driver)], self.root, self.output / "nested.log", .3, cleanup_grace=2)
        self.assertEqual(receipt["exitCode"], 124)
        self.assertIsNone(receipt["cleanupError"])
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pid_file.read_text()), 0)

    def test_clean_dev_outer_timeout_is_recorded(self):
        sandbox = self.root / "clean"
        sandbox.mkdir()
        successful = self.fake_driver()
        def driver(command, root, output, timeout, cleanup_grace=2):
            if "run-checks.py" in command[3]:
                return successful(command, root, output, timeout)
            return {"exitCode": 124, "timedOut": True}
        with patch.object(clean, "tmux_context", return_value={}), patch.object(clean, "run", side_effect=driver):
            self.assertEqual(clean.prove(sandbox, self.output, "current", .01), 1)
        receipt = json.loads((self.output / "clean-receipt.json").read_text())
        self.assertEqual(len(receipt["drivers"]), 2)
        self.assertTrue(receipt["drivers"][1]["timedOut"])

    def test_lookup_timeout_does_not_wait_for_descendant_pipe(self):
        pid_file = self.root / "lookup-pid"
        code = "import subprocess,time; p=subprocess.Popen(['sleep','60']); open(" + repr(str(pid_file)) + ",'w').write(str(p.pid)); time.sleep(60)"
        with self.assertRaises(subprocess.TimeoutExpired):
            runtime.bounded_output([sys.executable, "-c", code], .3)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pid_file.read_text()), 0)
