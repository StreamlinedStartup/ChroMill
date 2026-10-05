"""Read-only Windmill native host. stdout contains framed JSON only."""
import datetime
import fcntl
import http.client
import json
import logging
import math
import os
import queue
import re
import select
import socket
import stat
import struct
import sys
import threading
import time
import urllib.parse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

NAME = "app.run_radar.windmill"
MAX_FRAME = 8192
MAX_RESPONSE = 524288
MAX_NATIVE_RESPONSE = 1048576
ID = re.compile(r"[a-zA-Z0-9_-]{1,64}\Z")
UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")


class Failure(Exception):
    pass


class JsonFloat(float):
    """Keep the HTTP numeric token for private JSON field rendering."""
    def __new__(cls, token):
        value = super().__new__(cls, token)
        value.token = token
        return value


def field_json(value, depth=0):
    if isinstance(value, JsonFloat):
        return value.token
    if isinstance(value, (list, dict)) and value:
        indent = "  " * (depth + 1)
        items = (json.dumps(key, ensure_ascii=False) + ": " + field_json(item, depth + 1)
                 for key, item in value.items()) if isinstance(value, dict) else (
                     field_json(item, depth + 1) for item in value)
        opening, closing = ("{", "}") if isinstance(value, dict) else ("[", "]")
        return opening + "\n" + indent + (",\n" + indent).join(items) + "\n" + "  " * depth + closing
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def credential_lock(path, deadline):
    try:
        fd = os.open(str(path) + ".run-radar.lock", os.O_CREAT | os.O_RDWR | os.O_NONBLOCK | os.O_NOFOLLOW, 0o600)
    except FileNotFoundError:
        raise Failure("fifo_missing") from None
    except OSError:
        raise Failure("fifo_permissions") from None
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_nlink != 1 or metadata.st_size != 0:
            raise Failure("fifo_permissions")
        while time.monotonic() < deadline:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return fd
            except BlockingIOError:
                # Poll lock contention within the same total credential deadline.
                select.select([], [], [], min(0.01, max(0, deadline - time.monotonic())))
            except OSError:
                raise Failure("fifo_permissions") from None
        raise Failure("fifo_locked_or_stalled")
    except BaseException:
        os.close(fd)
        raise


def credentials(path, timeout=3):
    deadline = time.monotonic() + timeout
    lock = credential_lock(path, deadline)
    fd = None
    try:
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        except OSError:
            raise Failure("fifo_missing") from None
        metadata = os.fstat(fd)
        if not stat.S_ISFIFO(metadata.st_mode) or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o600:
            raise Failure("fifo_permissions")
        data = bytearray()
        while time.monotonic() < deadline:
            if select.select([fd], [], [], min(0.05, max(0, deadline - time.monotonic())))[0]:
                try:
                    part = os.read(fd, 4096)
                except BlockingIOError:
                    # Readiness is advisory if a non-helper reader drains the pipe.
                    continue
                if part:
                    data.extend(part)
                    if len(data) > 16384:
                        raise Failure("variables_invalid")
                elif data:
                    break
                else:
                    time.sleep(0.01)
        else:
            raise Failure("fifo_locked_or_stalled")
        values = {}
        for line in data.decode("utf-8").splitlines():
            key, sep, value = line.removeprefix("export ").partition("=")
            if key.strip() in ("WMILL_URL", "WMILL_API_KEY") and sep:
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                values[key.strip()] = value
        url, token = values.get("WMILL_URL", ""), values.get("WMILL_API_KEY", "")
        if not url or not token:
            raise Failure("variables_missing")
        parsed = urllib.parse.urlsplit(url)
        # Credentials and base paths in a URL are deliberately unsupported.
        if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise Failure("variables_invalid")
        if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise Failure("https_required")
        if any(ord(c) < 33 or ord(c) > 126 for c in token) or len(token) > 4096:
            raise Failure("variables_invalid")
        _ = parsed.port
        return url.rstrip("/"), token
    except (UnicodeError, ValueError):
        raise Failure("variables_invalid") from None
    finally:
        if fd is not None:
            os.close(fd)
        os.close(lock)


def get_json(instance, token, path, plain=False, inspection=False, deadline=None):
    parsed = urllib.parse.urlsplit(instance)
    cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    remaining = 5 if deadline is None else min(5, deadline - time.monotonic())
    if remaining <= 0:
        raise Failure("network_timeout")
    connection = cls(parsed.hostname, parsed.port, timeout=remaining)
    watchdog = None
    try:
        connection.connect()
        active_socket = connection.sock
        def interrupt():
            try:
                active_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                return
        remaining = 8 if deadline is None else deadline - time.monotonic()
        if remaining <= 0:
            raise Failure("network_timeout")
        if deadline is not None:
            active_socket.settimeout(remaining)
        watchdog = threading.Timer(remaining, interrupt)
        watchdog.daemon = True
        watchdog.start()
        connection.request("GET", path, headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
        response = connection.getresponse()
        if 300 <= response.status < 400:
            raise Failure("redirect_rejected")
        if response.status == 401:
            raise Failure("authentication_expired")
        if response.status in (403, 404):
            raise Failure(("forbidden" if response.status == 403 else "deleted") if inspection else "access_denied")
        if response.status != 200:
            raise Failure("server_error")
        # A total deadline also bounds a peer that dribbles response bytes.
        deadline = min(deadline, time.monotonic() + 5) if deadline is not None else time.monotonic() + 5
        chunks = bytearray()
        while True:
            if time.monotonic() >= deadline:
                raise Failure("network_timeout")
            part = response.read1(min(4096, MAX_RESPONSE + 1 - len(chunks)))
            if not part:
                break
            chunks.extend(part)
            if len(chunks) > MAX_RESPONSE:
                raise Failure("response_too_large")
        # Never return the credential even if a compromised server echoes it.
        if token.encode() in chunks:
            raise Failure("credential_echo")
        try:
            payload = chunks.decode("utf-8") if plain else json.loads(chunks, parse_float=JsonFloat)
            def contains_token(value):
                if isinstance(value, str):
                    return token in value
                if isinstance(value, list):
                    return any(contains_token(item) for item in value)
                if isinstance(value, dict):
                    return any(contains_token(key) or contains_token(item) for key, item in value.items())
                return False
            if contains_token(payload):
                raise Failure("credential_echo")
            return payload
        except (ValueError, UnicodeError):
            raise Failure("response_invalid") from None
    except (OSError, http.client.HTTPException):
        raise Failure("network_failure") from None
    finally:
        if watchdog:
            watchdog.cancel()
        connection.close()


def text(value, limit):
    if not isinstance(value, str) or not value or len(value) > limit or any(ord(c) < 32 for c in value):
        raise Failure("response_invalid")
    return value


def timestamp(value):
    try:
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})", value):
            raise ValueError()
        if not value.endswith("Z") and (int(value[-5:-3]) >= 24 or int(value[-2:]) >= 60):
            raise ValueError()
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(datetime.timezone.utc)
    except (ValueError, AttributeError, TypeError):
        raise Failure("response_invalid") from None


def valid_timezone(value):
    if not isinstance(value, str) or len(value) > 100 or not re.fullmatch(r"[A-Za-z_]+(?:/[A-Za-z0-9_+.-]+)*", value):
        return False
    try:
        ZoneInfo(value)
        return True
    except (ZoneInfoNotFoundError, ValueError):
        return False


def schedule_path(job):
    if not isinstance(job, dict):
        return None
    path = job.get("schedule_path") or (job.get("trigger") if job.get("trigger_kind") == "schedule" else None)
    return path if isinstance(path, str) and len(path) <= 300 and re.fullmatch(r"[A-Za-z0-9_-]+(?:/[A-Za-z0-9_.-]+)+", path) and not any(part in (".", "..") for part in path.split("/")) else None


def schedule_timezones(instance, token, workspace, jobs, exact=False):
    # Job timestamps do not identify a named timezone. Only current schedules do.
    paths = {path for job in jobs if (path := schedule_path(job))}
    found = {}
    base = "/api/w/" + workspace + "/schedules/"
    def accept(schedule):
        if not isinstance(schedule, dict) or schedule.get("workspace_id", workspace) != workspace:
            raise Failure("response_invalid")
        path = schedule.get("path")
        if isinstance(path, str) and path in paths and valid_timezone(schedule.get("timezone")):
            found[path] = schedule["timezone"]
        return path
    try:
        deadline = time.monotonic() + 2
        if exact:
            for path in paths:
                schedule = get_json(instance, token, base + "get/" + urllib.parse.quote(path, safe="/"), inspection=True, deadline=deadline)
                if not isinstance(schedule, dict) or schedule.get("path") != path:
                    raise Failure("response_invalid")
                accept(schedule)
        elif paths:
            page, seen = 0, set()
            while paths - seen:
                if page >= 10 or time.monotonic() >= deadline:
                    raise Failure("network_timeout")
                rows = get_json(instance, token, base + "list?per_page=100&page=" + str(page), deadline=deadline)
                if not isinstance(rows, list) or len(rows) > 100:
                    raise Failure("response_invalid")
                for row in rows:
                    path = accept(row)
                    if not isinstance(path, str) or path in seen:
                        raise Failure("response_invalid")
                    seen.add(path)
                if len(rows) < 100:
                    break
                page += 1
    except Failure:
        # Optional schedule access must not prevent inspection. No private data is logged.
        logging.warning('{"event":"schedule_timezone_unavailable"}')
    return found


def runs(payload, workspace, now, timezones=None, limit=100):
    if not isinstance(payload, list) or len(payload) > 1000:
        raise Failure("response_invalid")
    result, ids = [], set()
    for job in payload:
        if not isinstance(job, dict) or job.get("workspace_id") != workspace:
            raise Failure("response_invalid")
        if job.get("parent_job") or job.get("is_flow_step") is True:
            continue
        run_id = text(job.get("id"), 36)
        if not UUID.fullmatch(run_id) or run_id in ids or job.get("is_flow_step") is not False or type(job.get("canceled")) is not bool:
            raise Failure("response_invalid")
        ids.add(run_id)
        kind = job.get("type")
        if kind == "QueuedJob" and type(job.get("running")) is bool:
            status = "canceled" if job["canceled"] else "running" if job["running"] else "queued"
        elif kind == "CompletedJob" and type(job.get("success")) is bool:
            status = "canceled" if job["canceled"] else "skipped" if job.get("is_skipped") is True else "success" if job["success"] else "failed"
        else:
            raise Failure("response_invalid")
        started = timestamp(job.get("started_at") or job.get("created_at"))
        if started > now:
            raise Failure("response_invalid")
        duration = job.get("duration_ms") if kind == "CompletedJob" else max(0, (now - started).total_seconds() * 1000) if status == "running" else 0
        if type(duration) not in (int, float, JsonFloat) or not math.isfinite(duration) or duration < 0:
            raise Failure("response_invalid")
        path = text(job.get("script_path") or job.get("job_kind"), 300)
        trigger = text(job.get("trigger_kind") or ("schedule" if job.get("schedule_path") else "Unknown"), 50)
        result.append({"id": run_id, "name": path.rsplit("/", 1)[-1], "path": path,
                       "status": status, "durationMs": duration, "trigger": trigger,
                       "startedAt": started.isoformat(timespec="milliseconds").replace("+00:00", "Z")})
        if "job_kind" in job:
            result[-1]["jobKind"] = text(job["job_kind"], 50)
        zone = (timezones or {}).get(schedule_path(job))
        if valid_timezone(zone):
            result[-1]["timezone"] = zone
    # Windmill adds pending jobs to the completed-job page size.
    return sorted(result, key=lambda job: job["startedAt"], reverse=True)[:limit]


def inspection(instance, token, workspace, run_id, offset=None, job=None):
    base = "/api/w/" + workspace + "/jobs_u/"
    if job is None:
        job = get_json(instance, token, base + "get/" + run_id, inspection=True)
    if not isinstance(job, dict) or job.get("id") != run_id or job.get("workspace_id") != workspace:
        raise Failure("response_invalid")
    metadata = runs([job], workspace, datetime.datetime.now(datetime.timezone.utc))
    if len(metadata) != 1:
        raise Failure("response_invalid")
    zone = schedule_timezones(instance, token, workspace, [job], exact=True).get(schedule_path(job))
    if zone:
        metadata[0]["timezone"] = zone
    def field(value, present):
        if not present:
            return {"state": "unavailable"}
        encoded = field_json(value)
        return {"state": "available", "text": encoded[:32000], "truncated": len(encoded) > 32000}
    fields = {"inputs": field(job.get("args"), "args" in job),
              "result": field(job.get("result"), "result" in job),
              "steps": field(job.get("flow_status"), job.get("flow_status") is not None)}
    endpoint = "get_flow_all_logs/" if job.get("job_kind") == "flow" else "get_logs/"
    try:
        logs = get_json(instance, token, base + endpoint + run_id, plain=True, inspection=True)
        fields["logs"] = {"state": "available", "text": logs[-64000:], "truncated": len(logs) > 64000}
        span = {"start": max(0, len(logs) - 64000), "end": len(logs)}
    except Failure as error:
        fields["logs"] = {"state": str(error)}
        span = {"start": offset or 0, "end": offset or 0}
    response = {"ok": True, "instance": instance, "workspace": workspace, "runId": run_id,
                "detail": {"run": metadata[0], **fields}}
    if offset is not None:
        response["offsets"] = span
    return response


def comparison(instance, token, workspace, run_id):
    response = {"ok": True, "instance": instance, "workspace": workspace, "runId": run_id,
                "state": "missing_metadata", "searched": 0}
    base = "/api/w/" + workspace
    selected = get_json(instance, token, base + "/jobs_u/get/" + run_id, inspection=True)
    if not isinstance(selected, dict) or selected.get("id") != run_id or selected.get("workspace_id") != workspace:
        raise Failure("response_invalid")
    kind = selected.get("job_kind")
    if kind not in ("script", "flow") or selected.get("parent_job") or selected.get("is_flow_step") is not False:
        return {**response, "state": "incompatible_type"}
    path, started = selected.get("script_path"), selected.get("started_at")
    if not path or not started or selected.get("type") != "CompletedJob":
        return response
    text(path, 300)
    before = timestamp(started)
    # The API path filter accepts comma lists and leading negation.
    if "," in path or path.startswith("!"):
        return {**response, "state": "unsupported_path"}
    candidates, seen = [], set()
    def eligible(row):
        return (row.get("script_path") == path and row.get("job_kind") == kind and
                not row.get("parent_job") and row.get("is_flow_step") is False and
                row.get("type") == "CompletedJob" and row.get("success") is True and
                row.get("canceled") is False and row.get("is_skipped") is False)
    for page in range(5):
        query = {"per_page": 100, "page": page, "order_desc": "true", "script_path_exact": path,
                 "success": "true", "is_skipped": "false", "has_null_parent": "true",
                 "is_flow_step": "false", "job_kinds": kind, "started_before": started}
        rows = get_json(instance, token, base + "/jobs/completed/list?" + urllib.parse.urlencode(query), inspection=True)
        if not isinstance(rows, list) or len(rows) > 100:
            raise Failure("response_invalid")
        response["searched"] += len(rows)
        for row in rows:
            if not isinstance(row, dict) or row.get("workspace_id") != workspace:
                raise Failure("response_invalid")
            identity = row.get("id")
            if not isinstance(identity, str) or not UUID.fullmatch(identity) or not eligible(row):
                raise Failure("response_invalid")
            if identity in seen:
                return {**response, "state": "search_limit"}
            seen.add(identity)
            if not row.get("started_at"):
                return response
            when = timestamp(row["started_at"])
            if when < before and identity != run_id:
                candidates.append((when, identity))
        if len(rows) < 100:
            break
    else:
        return {**response, "state": "search_limit"}
    if not candidates:
        return {**response, "state": "no_baseline"}
    baseline_time, baseline_id = max(candidates)
    try:
        baseline = get_json(instance, token, base + "/jobs_u/get/" + baseline_id, inspection=True)
    except Failure as error:
        if str(error) in ("forbidden", "deleted"):
            return {**response, "state": "baseline_" + str(error)}
        raise
    if not isinstance(baseline, dict) or baseline.get("id") != baseline_id or baseline.get("workspace_id") != workspace or not eligible(baseline) or timestamp(baseline.get("started_at")) != baseline_time:
        raise Failure("response_invalid")
    def snapshot(job):
        value = job.get("script_hash")
        version = {"state": "unavailable"}
        if value is not None:
            if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{1,32}", value):
                raise Failure("response_invalid")
            version = {"state": "available", "text": value, "truncated": False}
        detail = inspection(instance, token, workspace, job["id"], job=job)["detail"]
        detail["run"]["startedAt"] = timestamp(job["started_at"]).isoformat(timespec="microseconds").replace("+00:00", "Z")
        if job.get("result") == "WINDMILL_TOO_BIG":
            detail["result"] = {"state": "response_too_large"}
        return {"detail": detail, "version": version}
    if type(selected.get("duration_ms")) not in (int, float, JsonFloat) or type(baseline.get("duration_ms")) not in (int, float, JsonFloat):
        return response
    return {**response, "state": "available", "kind": kind, "selected": snapshot(selected), "baseline": snapshot(baseline)}


def valid_flow_path(value):
    return isinstance(value, str) and 0 < len(value) <= 300 and not re.search(r"[\x00-\x1f,]", value) and not value.startswith("!")


def browse(instance, token, message):
    workspace, page = message["workspace"], message["page"]
    base = "/api/w/" + workspace
    query = {"per_page": 100, "page": page, "order_desc": "false" if message["op"] == "flows" else "true"}
    if message["op"] == "flows":
        query["show_archived"] = "false"
        flows, has_more = [], False
        for kind in ("flow", "script"):
            query["order_desc"] = "true" if kind == "script" else "false"
            if kind == "script":
                query["include_without_main"] = "true"
            rows = get_json(instance, token, base + "/" + kind + "s/list?" + urllib.parse.urlencode(query))
            if not isinstance(rows, list) or len(rows) > 100:
                raise Failure("response_invalid")
            has_more = has_more or len(rows) == 100
            seen = set()
            for row in rows:
                if not isinstance(row, dict) or row.get("workspace_id", workspace) != workspace or not valid_flow_path(row.get("path")) or ("archived" in row and row["archived"] is not False):
                    raise Failure("response_invalid")
                summary = row.get("summary")
                if summary is None:
                    summary = ""
                if not isinstance(summary, str) or len(summary) > 1000 or re.search(r"[\x00-\x1f]", summary):
                    raise Failure("response_invalid")
                if row["path"] in seen:
                    if kind == "flow":
                        raise Failure("response_invalid")
                    continue
                seen.add(row["path"])
                flows.append({"path": row["path"], "summary": summary, "kind": kind})
        return {"ok": True, "instance": instance, "workspace": workspace, "page": page, "hasMore": has_more, "flows": flows}
    query.update({"has_null_parent": "true", "is_flow_step": "false"})
    path = message["flowPath"]
    if path is not None:
        query.update({"script_path_exact": path, "job_kinds": message["flowKind"]})
    endpoint = "/jobs/list?" if page == 1 else "/jobs/completed/list?"
    rows = get_json(instance, token, base + endpoint + urllib.parse.urlencode(query))
    if not isinstance(rows, list) or len(rows) > (1000 if page == 1 else 100):
        raise Failure("response_invalid")
    for row in rows:
        if not isinstance(row, dict) or row.get("parent_job") or row.get("is_flow_step") is not False or (page != 1 and row.get("type") != "CompletedJob") or (path is not None and (row.get("script_path") != path or row.get("job_kind") != message["flowKind"])):
            raise Failure("response_invalid")
    count = sum(row.get("type") == "CompletedJob" for row in rows)
    if count > 100:
        raise Failure("response_invalid")
    now = datetime.datetime.now(datetime.timezone.utc)
    return {"ok": True, "instance": instance, "workspace": workspace, "mode": "live", "snapshotAt": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "page": page, "flowPath": path, "flowKind": message["flowKind"], "hasMore": count == 100, "runs": runs(rows, workspace, now, schedule_timezones(instance, token, workspace, rows), limit=1000)}


def handle(message, fifo):
    if not isinstance(message, dict) or message.get("op") not in ("status", "workspaces", "recent", "inspect", "follow", "compare", "flows", "history"):
        raise Failure("request_invalid")
    op = message["op"]
    if op in ("flows", "history"):
        allowed = {"op", "workspace", "instance", "page"} | ({"flowPath", "flowKind"} if op == "history" else set())
        if set(message) != allowed or not isinstance(message["workspace"], str) or not ID.fullmatch(message["workspace"]) or type(message["page"]) is not int or not 1 <= message["page"] <= 10000:
            raise Failure("request_invalid")
        if op == "history" and not (message["flowPath"] is None and message["flowKind"] is None or valid_flow_path(message["flowPath"]) and message["flowKind"] in ("script", "flow")):
            raise Failure("request_invalid")
        instance, token = credentials(fifo)
        if message["instance"] != instance:
            raise Failure("request_invalid")
        return browse(instance, token, message)
    allowed = {"op", "workspace", "runId", "instance", "offset"} if op == "follow" else {"op", "workspace", "runId", "instance"} if op in ("inspect", "compare") else {"op", "workspace"} if op == "recent" else {"op"}
    if set(message) != allowed and not (op in ("recent", "workspaces") and set(message) == allowed | {"instance"}):
        raise Failure("request_invalid")
    workspace = message.get("workspace")
    if op in ("recent", "inspect", "follow", "compare") and (not isinstance(workspace, str) or not ID.fullmatch(workspace)):
        raise Failure("request_invalid")
    if op in ("inspect", "follow", "compare") and (not isinstance(message["runId"], str) or not UUID.fullmatch(message["runId"])):
        raise Failure("request_invalid")
    if op == "follow" and (type(message["offset"]) is not int or not 0 <= message["offset"] <= 9007199254740991):
        raise Failure("request_invalid")
    instance, token = credentials(fifo)
    if "instance" in message and message["instance"] != instance:
        raise Failure("request_invalid")
    if op in ("inspect", "follow", "compare"):
        if op == "compare":
            return comparison(instance, token, workspace, message["runId"])
        return inspection(instance, token, workspace, message["runId"], message["offset"] if op == "follow" else None)
    if op == "status":
        return {"ok": True, "instance": instance, "helper": "installed"}
    if op == "workspaces":
        payload = get_json(instance, token, "/api/workspaces/list")
        if not isinstance(payload, list) or len(payload) > 1000:
            raise Failure("response_invalid")
        workspaces = []
        for value in payload:
            if not isinstance(value, dict) or not isinstance(value.get("id"), str) or not ID.fullmatch(value["id"]):
                raise Failure("response_invalid")
            workspaces.append(value["id"])
        return {"ok": True, "instance": instance, "workspaces": workspaces}
    payload = get_json(instance, token, "/api/w/" + workspace + "/jobs/list?per_page=100&has_null_parent=true&is_flow_step=false")
    now = datetime.datetime.now(datetime.timezone.utc)
    return {"ok": True, "mode": "live", "instance": instance, "workspace": workspace,
            "snapshotAt": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"), "runs": runs(payload, workspace, now, schedule_timezones(instance, token, workspace, payload) if isinstance(payload, list) else {})}


def read_exact(stream, size):
    data = bytearray()
    while len(data) < size:
        part = stream.read(size - len(data))
        if not part:
            if not data:
                return None
            raise Failure("frame_truncated")
        data.extend(part)
    return bytes(data)


def encode_response(response):
    try:
        data = json.dumps(response, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (ValueError, UnicodeError):
        data = b'{"ok":false,"code":"response_invalid"}'
    if len(data) > MAX_NATIVE_RESPONSE:
        data = b'{"ok":false,"code":"response_too_large"}'
    return data


def serve(fifo, extension_id, origin):
    if not re.fullmatch(r"[a-p]{32}", extension_id) or origin != "chrome-extension://" + extension_id + "/":
        return 1
    requests = queue.Queue(maxsize=1)

    def work():
        while True:
            message = requests.get()
            try:
                response = handle(message, fifo)
            except Failure as error:
                response = {"ok": False, "code": str(error)}
            except Exception:
                logging.error('{"event":"native_internal_error"}')
                response = {"ok": False, "code": "helper_failure"}
            data = encode_response(response)
            try:
                sys.stdout.buffer.write(struct.pack("=I", len(data)) + data)
                sys.stdout.buffer.flush()
            except BrokenPipeError:
                return

    threading.Thread(target=work, daemon=True).start()
    try:
        while True:
            header = read_exact(sys.stdin.buffer, 4)
            if header is None:
                return 0  # EOF exits the process, including any authenticated work.
            size = struct.unpack("=I", header)[0]
            if size == 0 or size > MAX_FRAME:
                raise Failure("frame_size")
            body = read_exact(sys.stdin.buffer, size)
            if body is None:
                raise Failure("frame_truncated")
            requests.put_nowait(json.loads(body))
    except (Failure, ValueError, UnicodeError, queue.Full):
        logging.error('{"event":"native_protocol_rejected"}')
        return 1


if __name__ == "__main__":
    logging.basicConfig(stream=sys.stderr, format="%(message)s", level=logging.ERROR)
    raise SystemExit(serve(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else ""))
