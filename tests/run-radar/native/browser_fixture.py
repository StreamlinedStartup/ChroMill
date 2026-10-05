"""Synthetic-only server and FIFO writer for production extension tests."""
from decimal import Decimal
import http.server
import json
import os
from pathlib import Path
import sys
import socket
import threading
import time
import urllib.parse
from test_host import job

fifo = Path(sys.argv[1])
os.mkfifo(fifo, 0o600)
mode = "normal"
stop = threading.Event()
requests = []

# Execute the synthetic workload. These are fixture executions, never real jobs.
executions = {}
for index, minute, inputs, path in [
        (1, 1, {"count": 1, "removed": True}, "f/tests/compare"),
        (6, 2, {"count": 2, "removed": True}, "f/tests/compare"),
        (2, 3, {"count": -1, "added": "<script>globalThis.pwned=true</script>"}, "f/tests/compare"),
        (3, 4, {"count": -1}, "f/tests/no-baseline")]:
    logs = ["fixture execution started"]
    try:
        if inputs["count"] < 0:
            raise ValueError("count must be positive")
        result = {"total": inputs["count"] * 2}
        success = True
        logs.append("fixture execution completed")
    except ValueError as error:
        result = {"error": str(error)}
        success = False
        logs.append(str(error))
    payload = job(index, started_at=f"2026-01-01T00:{minute:02d}:00Z", job_kind="script",
                  script_path=path, success=success, is_skipped=False, args=inputs, result=result,
                  script_hash="abc1" if success else "abc2", duration_ms=100 if success else 250)
    executions[payload["id"]] = {"job": payload, "logs": "\n".join(logs), "executed": True}

numeric_executions = {}
for identity, entry in executions.items():
    inputs = {**entry["job"]["args"], "nested": {"ids": [9007199254740992 if entry["job"]["success"] else 9007199254740993]}}
    # Execute an integer-preserving echo workload for inputs and results.
    result = {"nested": {"ids": [inputs["nested"]["ids"][0] + 0]}}
    try:
        if inputs["count"] < 0:
            raise ValueError("count must be positive")
        success = True
    except ValueError as error:
        result["error"] = str(error)
        success = False
    payload = {**entry["job"], "args": inputs, "result": result, "success": success}
    numeric_executions[identity] = {"job": payload, "logs": entry["logs"], "executed": True}


decimal_executions = {}
for identity, entry in executions.items():
    token = "1.0" if entry["job"]["success"] else "1.00000000000000001"
    # Execute a decimal-preserving identity workload before rendering raw HTTP JSON.
    inputs = {**entry["job"]["args"], "nested": {"decimals": [token], "underflow": ["1e-400"]}}
    result = {"nested": {"decimals": [str(Decimal(token))], "underflow": [str(Decimal("1e-400"))]}}
    payload = {**entry["job"], "args": inputs, "result": result}
    decimal_executions[identity] = {"job": payload, "logs": entry["logs"], "executed": True}


def fixture_json(value, current):
    body = json.dumps(value)
    if current == "compare_decimal":
        for token in ["1.0", "1.00000000000000001", "1e-400", "1E-400"]:
            body = body.replace(json.dumps(token), token)
    return body.encode()


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        record = {"method": self.command, "namedPath": self.path.split("?")[0],
                  "authenticated": self.headers.get("Authorization") == "Bearer synthetic-browser-credential"}
        requests.append(record)
        current = mode
        if current.startswith("history"):
            parsed = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            page = int(query.get("page", ["1"])[0])
            flow = query.get("script_path_exact", [None])[0]
            scope = parsed.path.split("/")[3] if parsed.path.startswith("/api/w/") else None
            path = flow or "f/tests/recent"
            status = 200 if record["authenticated"] else 401
            if current == "history_failure" and "/jobs/" in parsed.path:
                status = 500
            if current == "history_delay" and flow is not None and query.get("job_kinds") == ["flow"] and "/jobs/" in parsed.path:
                record["delayedHistory"] = True
                time.sleep(2)
            if "/flows/list" in parsed.path:
                payload = [{"path": f"f/tests/catalog_{i}", "summary": f"Catalog {i}"} for i in range(100)] if page == 1 else [{"path": "f/tests/old", "summary": "Old payroll"}]
            elif "/scripts/list" in parsed.path:
                payload = [{"path": f"f/tests/script_{i}", "summary": f"Script {i}", "archived": False} for i in range(100)] if page == 1 else [
                    {"path": "f/tests/old", "summary": "Old payroll", "archived": False},
                    {"path": "f/tests/old", "summary": "Old version", "archived": False}]
            elif "/jobs_u/get/" in parsed.path:
                index = int(parsed.path.rsplit("-", 1)[-1])
                payload = job(index, script_path="f/tests/old", job_kind="script" if index >= 1000 else "flow", args={}, result={"ok": True})
            elif "/jobs_u/" in parsed.path:
                payload = "history fixture logs"
            elif "/jobs/" in parsed.path:
                kind = query.get("job_kinds", ["flow"])[0]
                payload = [job(i + (100 if page > 1 else 0) + (1000 if kind == "script" else 0), script_path=path, job_kind=kind) for i in range(1, 2 if page > 1 else 101)]
                if flow is None and page == 1:
                    payload[0]["job_kind"] = "script"
                    payload[1]["job_kind"] = "preview"
                    payload[2].pop("job_kind", None)
            elif scope is None:
                payload = [{"id": "fixture"}, {"id": "second"}]
            else:
                payload = []
            self.send_response(status)
            self.end_headers()
            self.wfile.write((payload.encode() if isinstance(payload, str) else json.dumps(payload).encode()))
            return
        if current.startswith("timezone"):
            parsed = urllib.parse.urlsplit(self.path)
            scope = parsed.path.split("/")[3] if parsed.path.startswith("/api/w/") else None
            values = [job(index, workspace_id=scope, started_at=f"2026-01-01T00:0{index-1}:00Z", job_kind="script", script_path="f/tests/times", script_hash="abc1", success=index == 1, is_skipped=False, args={"rawTimestamp": "2026-01-01T00:00:00Z"}, result={"ok": True}) for index in [1, 2, 3]]
            values[0].update(trigger_kind="schedule", trigger="f/tests/tokyo")
            values[2]["schedule_path"] = "f/tests/missing"
            schedule = {"path": "f/tests/tokyo", "timezone": "Bad/Zone" if current == "timezone_invalid" else "posix/America/New_York" if current == "timezone_unsupported" else "Asia/Tokyo", "workspace_id": scope}
            status = 200 if record["authenticated"] else 401
            if "/schedules/get/" in parsed.path and (parsed.path.endswith("missing") or current in ("timezone_deleted", "timezone_denied")):
                status = 403 if current == "timezone_denied" else 404
            if "/schedules/list" in parsed.path and current == "timezone_denied":
                status = 403
            if scope is None:
                body = json.dumps([{"id": "fixture"}, {"id": "second"}]).encode()
            elif "/schedules/list" in parsed.path:
                body = json.dumps([] if current == "timezone_deleted" else [schedule]).encode()
            elif "/schedules/get/" in parsed.path:
                body = json.dumps(schedule).encode()
            elif "/get_logs/" in parsed.path:
                body = b"timezone fixture logs"
            elif "/jobs_u/get/" in parsed.path:
                body = json.dumps(next(value for value in values if value["id"] == parsed.path.rsplit("/", 1)[-1])).encode()
            elif "/completed/list" in parsed.path:
                body = json.dumps(values[:1]).encode()
            else:
                body = json.dumps(values).encode()
            self.send_response(status)
            self.end_headers()
            self.wfile.write(body)
            return
        if current.startswith("workspace_"):
            parsed = urllib.parse.urlsplit(self.path)
            scope = parsed.path.split("/")[3] if parsed.path.startswith("/api/w/") else None
            status = 200 if self.headers.get("Authorization") == "Bearer synthetic-browser-credential" else 401
            if scope is not None and (scope not in ("fixture", "second") or current == "workspace_revoked" and scope == "second"):
                status = 403
            values = [job(1, workspace_id=scope, started_at="2026-01-01T00:01:00Z", script_hash="abc1"),
                      job(2, workspace_id=scope, started_at="2026-01-01T00:02:00Z", success=False, script_hash="abc2"),
                      job(3, workspace_id=scope, started_at="2026-01-01T00:03:00Z", kind="CompletedJob" if current == "workspace_failed" and scope == "fixture" else "QueuedJob", running=True, success=False)]
            for value in values:
                value.update(script_path=f"f/{scope}/run", args={"scope": scope}, result={"scope": scope})
            if current == "workspace_delay" and scope == "fixture" or current == "workspace_discovery_delay" and scope is None:
                record["delayedSeconds"] = 4
                time.sleep(4)
            self.send_response(status)
            self.end_headers()
            if scope is None:
                body = json.dumps([{"id": "fixture"}, {"id": "second"}]).encode()
            elif "/get_logs/" in parsed.path or "/get_flow_all_logs/" in parsed.path:
                body = f"{scope} private logs\n".encode()
            elif "/jobs_u/get/" in parsed.path:
                body = json.dumps(next(value for value in values if value["id"] == parsed.path.rsplit("/", 1)[-1])).encode()
            elif "/completed/list" in parsed.path:
                body = json.dumps(values[:1]).encode()
            else:
                body = json.dumps([] if current == "workspace_empty" and scope == "second" else values).encode()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                record["clientDisconnected"] = True
            record["responseAttempted"] = True
            return
        if current.startswith("compare"):
            history = decimal_executions if current == "compare_decimal" else numeric_executions if current == "compare_numeric" else executions
            parsed = urllib.parse.urlsplit(self.path)
            run_id = parsed.path.rsplit("/", 1)[-1]
            status = 403 if current == "compare_forbidden" and run_id.endswith("000000000006") and "/get/" in parsed.path else 200
            if current == "compare_delay" and "/completed/list" in parsed.path:
                time.sleep(2)
            self.send_response(status)
            self.end_headers()
            if "/get_logs/" in parsed.path or "/get_flow_all_logs/" in parsed.path:
                body = history[run_id]["logs"].encode()
            elif "/jobs_u/get/" in parsed.path:
                payload = dict(history[run_id]["job"])
                if current == "compare_missing":
                    payload.pop("script_hash", None)
                    payload.pop("result", None)
                if current == "compare_large":
                    payload["args"] = {"large": "x" * 40000}
                if current == "compare_incompatible":
                    payload["job_kind"] = "preview"
                if current == "compare_flow":
                    payload["job_kind"] = "flow"
                    payload.pop("script_hash", None)
                body = fixture_json(payload, current)
            elif "/jobs/completed/list" in parsed.path:
                query = urllib.parse.parse_qs(parsed.query)
                values = [entry["job"] for entry in history.values() if entry["job"]["success"] and entry["job"]["script_path"] == query["script_path_exact"][0] and entry["job"]["started_at"] <= query["started_before"][0]]
                if current == "compare_limit":
                    values = [values[0]] * 100
                if current == "compare_flow":
                    values = [{**value, "job_kind": "flow"} for value in values]
                # Deliberately order by creation, not execution start.
                body = fixture_json(values, current)
            elif "/workspaces/list" in parsed.path:
                body = json.dumps([{"id": "fixture"}]).encode()
            else:
                body = json.dumps([entry["job"] for entry in history.values()]).encode()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        pin_state = current.startswith("pin_")
        if current == "network":
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        detail = "/jobs_u/" in self.path
        if current == "delay" or current == "detail_delay" and detail:
            time.sleep(2)
        status = {"pin_deleted": 404 if detail else 200, "pin_denied": 403 if detail else 200, "expired": 401, "denied": 403, "redirect": 302, "deleted": 404}.get(current, 200)
        self.send_response(status)
        if status == 302:
            self.send_header("Location", "http://127.0.0.1:1/blocked")
        self.end_headers()
        if current == "malformed":
            body = b"invalid json"
        elif current == "malformed_job":
            body = json.dumps([job(type="UnexpectedJob")]).encode()
        elif current == "oversized":
            body = b"x" * 524289
        elif current == "empty":
            body = b"[]"
        elif "/jobs_u/get_logs/" in self.path or "/jobs_u/get_flow_all_logs/" in self.path:
            body = (("older line\n" * 8000 if current == "large_logs" else "first line\n") + "<img src=x onerror=globalThis.pwned=true>\nfinal log line").encode()
            if current.startswith("follow_"):
                body = {"follow_start": "starté\npar", "follow_progress": "starté\npartial line\nstep-a done\n", "follow_complete": "starté\npartial line\nstep-a done\nfinished\n"}.get(current, "starté\npar").encode()
            if current == "unicode_logs":
                body = ("\U0001f600" * 64001).encode()
        elif "/jobs_u/get/" in self.path:
            run_id = self.path.rsplit("/", 1)[-1]
            body = json.dumps(job(int(run_id.rsplit("-", 1)[-1]), job_kind="flow", args={"input": "<script>globalThis.pwned=true</script>"}, result={"answer": "<img src=x onerror=globalThis.pwned=true>"}, success=not (current == "badge_failed" and run_id.endswith("000000000003")), flow_status={"modules": [{"id": "step-a", "type": "Success", "job": run_id}]})).encode()
            if current.startswith("follow_"):
                complete = current == "follow_complete"
                payload = job(int(run_id.rsplit("-", 1)[-1]), kind="CompletedJob" if complete else "QueuedJob", running=True, job_kind="flow", args={}, flow_status={"modules": [{"id": "step-a", "type": "Success" if current != "follow_start" else "InProgress"}]})
                if complete:
                    payload["result"] = {"finished": True}
                body = json.dumps(payload).encode()
            if current == "unavailable":
                body = json.dumps(job(int(run_id.rsplit("-", 1)[-1]))).encode()
        elif self.path.startswith("/api/workspaces/list"):
            body = json.dumps([{"id": "fixture"}]).encode()
        elif current == "badge_failed":
            body = json.dumps([job(1), job(2, success=False), job(3, success=False), job(4, kind="QueuedJob"), job(5, canceled=True)]).encode()
        elif pin_state:
            body = json.dumps([job(2)]).encode()
        else:
            body = json.dumps([job(1), job(2, success=False), job(3, kind="QueuedJob", running=True),
                               job(4, kind="QueuedJob"), job(5, canceled=True)]).encode()
        try:
            if current.startswith("follow_"):
                for start in range(0, len(body), 3):
                    self.wfile.write(body[start:start + 3])
                    self.wfile.flush()
            else:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return

    def log_message(self, *_args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()


def writer():
    while not stop.wait(0.03):
        if mode == "stalled":
            continue
        try:
            fd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
        except OSError:
            continue
        data = f"WMILL_URL=http://127.0.0.1:{server.server_port}\n"
        if mode != "missing_variables":
            data += "WMILL_API_KEY=synthetic-browser-credential\n"
        try:
            os.write(fd, data.encode())
        except BrokenPipeError:
            pass
        finally:
            os.close(fd)


threading.Thread(target=writer, daemon=True).start()
sys.stdout.write(json.dumps({"port": server.server_port}) + "\n")
sys.stdout.flush()
try:
    for line in sys.stdin:
        command = json.loads(line)
        mode = command["mode"]
        history = decimal_executions if mode == "compare_decimal" else numeric_executions if mode == "compare_numeric" else executions
        sys.stdout.write(json.dumps({"mode": mode, "requests": requests, "fixtureExecutions": [{"id": identity, "executed": entry["executed"], "success": entry["job"]["success"]} for identity, entry in history.items()]}) + "\n")
        sys.stdout.flush()
finally:
    stop.set()
    server.shutdown()
    server.server_close()
    fifo.unlink(missing_ok=True)
