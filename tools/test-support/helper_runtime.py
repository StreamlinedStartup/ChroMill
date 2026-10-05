from pathlib import Path
import argparse
import json
import os
import signal
import subprocess
import time
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[2]


def bounded_output(command, timeout):
    with tempfile.TemporaryFile(mode="w+") as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                   text=True, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                if process.poll() is None:
                    raise
            process.wait(timeout=2)
        log.seek(0)
        output = log.read()
    if code != 0:
        raise subprocess.CalledProcessError(code, command, output=output)
    return subprocess.CompletedProcess(command, code, output)


def group_alive(pgid):
    result = bounded_output(["rtk", "proxy", "ps", "-axo", "pgid=,stat="], timeout=5)
    return any(int(fields[0]) == pgid and not fields[1].startswith("Z")
               for line in result.stdout.splitlines() if len(fields := line.split()) == 2)


def stop_group(process, first=signal.SIGTERM, grace=2):
    escalated = False
    previous = signal.signal(signal.SIGTERM, signal.SIG_IGN)
    try:
        for sig in (first, signal.SIGTERM, signal.SIGKILL):
            process.poll()
            if not group_alive(process.pid):
                break
            try:
                os.killpg(process.pid, sig)
            except (ProcessLookupError, PermissionError):
                if group_alive(process.pid):
                    raise
                break
            deadline = time.monotonic() + grace
            while time.monotonic() < deadline:
                process.poll()
                if not group_alive(process.pid):
                    process.wait(timeout=grace)
                    return escalated
                time.sleep(0.02)
            escalated = True
        process.wait(timeout=grace)
        if group_alive(process.pid):
            raise RuntimeError("Process group survived bounded cleanup")
        return escalated
    finally:
        signal.signal(signal.SIGTERM, previous)


def run(command, root, output, timeout, cleanup_grace=2):
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    timed_out = False
    cleanup_error = None
    with output.open("w") as log:
        process = subprocess.Popen(command, cwd=root, stdout=log,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            code = 124
        finally:
            try:
                stop_group(process, grace=cleanup_grace)
            except Exception as error:
                cleanup_error = str(error)
                code = 1
    return {"command": command, "cwd": str(root), "startedAt": started,
            "exitCode": code, "timedOut": timed_out, "cleanupError": cleanup_error, "timeoutSeconds": timeout,
            "output": str(output)}


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def interrupted(signum, frame):
    raise InterruptedError("Evidence driver received signal " + str(signum))


def arguments(description):
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--run-id", default=uuid.uuid4().hex)
    return parser


def output_directory(args):
    output = args.output or ROOT / "evidence/WMLC-002/repair-runs" / args.run_id
    output.mkdir(parents=True, exist_ok=False)
    return output


def tmux_context(timeout=5):
    socket = os.environ.get("TMUX", "").split(",")[0]
    pane = os.environ.get("TMUX_PANE", "")
    if not socket or not pane:
        raise RuntimeError("The driver requires its current named tmux pane")
    result = bounded_output(["rtk", "proxy", "tmux", "-S", socket,
                             "display-message", "-p", "-t", pane,
                             "#{pane_id}|#{session_name}"],
                            timeout=timeout)
    identity, session = result.stdout.strip().split("|")
    if identity != pane or not session:
        raise RuntimeError("tmux returned an unrelated pane or an empty session")
    return {"tmuxPane": pane, "tmuxSession": session, "tmuxSocket": socket}
