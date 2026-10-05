import signal
import subprocess
import time
from helper_runtime import ROOT, arguments, output_directory, stop_group, tmux_context, write


def smoke(root, output, readiness_timeout=30, grace=2):
    receipt = {"command": ["rtk", "proxy", "mise", "run", "dev"], "cwd": str(root),
               "ready": False, "exitCode": 1, "stopReason": "Startup did not complete"}
    process = None
    try:
        receipt.update(tmux_context())
        with (output / "dev.log").open("w") as log:
            process = subprocess.Popen(receipt["command"], cwd=root, stdout=log,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + readiness_timeout
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    receipt["stopReason"] = "Development process exited before readiness"
                    break
                if (root / "build/chrome-mv3-dev/manifest.json").exists() and "Extension re-packaged" in (output / "dev.log").read_text():
                    receipt["ready"] = True
                    receipt["stopReason"] = "Intentional SIGINT after development readiness"
                    break
                time.sleep(0.1)
            else:
                receipt["stopReason"] = "Development readiness deadline expired"
    except Exception as error:
        receipt["stopReason"] = "Development driver failed"
        receipt["error"] = str(error)
    finally:
        if process is not None:
            try:
                escalated = stop_group(process, signal.SIGINT, grace)
                receipt["processExitCode"] = process.returncode
                receipt["shutdownEscalated"] = escalated
                if receipt["ready"] and not escalated and process.returncode in (0, -signal.SIGINT, 130):
                    receipt["exitCode"] = 0
                elif escalated:
                    receipt["stopReason"] = "Development shutdown required escalation"
            except Exception as error:
                receipt["stopReason"] = "Development cleanup failed"
                receipt["cleanupError"] = str(error)
    return receipt


def main():
    parser = arguments("Prove development readiness in the current tmux pane")
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    output = output_directory(args)
    receipt = smoke(ROOT, output, args.timeout)
    receipt["runId"] = args.run_id
    write(output / "dev-receipt.json", receipt)
    return receipt["exitCode"]


if __name__ == "__main__":
    raise SystemExit(main())
