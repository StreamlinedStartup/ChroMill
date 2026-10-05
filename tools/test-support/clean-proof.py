import json
import shutil
from pathlib import Path
from helper_runtime import arguments, output_directory, run, tmux_context, write

TASKS = ["install", "helper-test", "test", "workflow-test", "lint", "typecheck", "build", "browser-test"]


def fresh_receipt(path, run_id):
    value = json.loads(path.read_text())
    if value.get("runId") != run_id or value.get("exitCode") != 0:
        raise RuntimeError("Child receipt is stale or reports failure")
    return value


def prove(clean, output, run_id, timeout=5000):
    receipt = {"root": str(clean), "runId": run_id, "exitCode": 1, "drivers": []}
    try:
        receipt.update(tmux_context())
        receipt["initialArtifacts"] = {name: (clean / name).exists() for name in
                                       ["node_modules", ".plasmo", ".parcel-cache", "build"]}
        if any(receipt["initialArtifacts"].values()):
            raise RuntimeError("Clean proof requires a fresh source copy")
        for script, name, tasks in [("run-checks.py", "suite", TASKS), ("dev-smoke.py", "dev", [])]:
            child_output = clean / "evidence/WMLC-002/repair-runs" / (run_id + "-" + name)
            if child_output.exists():
                raise RuntimeError("Child evidence directory already exists")
            command = ["rtk", "proxy", "python3", str(clean / "tools/test-support" / script),
                       "--output", str(child_output), "--run-id", run_id] + tasks
            driver = run(command, clean, output / (name + "-driver.log"), timeout, cleanup_grace=15)
            receipt["drivers"].append(driver)
            if driver["exitCode"] != 0:
                raise RuntimeError(name + " driver failed")
            child = fresh_receipt(child_output / ("commands.json" if name == "suite" else "dev-receipt.json"), run_id)
            receipt[name] = child
            if name == "suite" and ([item["command"][-1] for item in child["commands"]] != TASKS or any(item["exitCode"] != 0 for item in child["commands"])):
                raise RuntimeError("Suite receipt contains missing or failed tasks")
            if name == "dev" and not child["ready"]:
                raise RuntimeError("Development bundle was not ready")
        receipt["exitCode"] = 0
    except Exception as error:
        receipt["error"] = str(error)
    finally:
        source = clean / "evidence/WMLC-002"
        if source.exists():
            shutil.copytree(source, output / "clean-artifacts", ignore=shutil.ignore_patterns("*.py", "__pycache__"))
        write(output / "clean-receipt.json", receipt)
    return receipt["exitCode"]


def main():
    parser = arguments("Capture fresh clean-install and development evidence")
    parser.add_argument("--clean", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=5000)
    args = parser.parse_args()
    return prove(args.clean.resolve(), output_directory(args), args.run_id, args.timeout)


if __name__ == "__main__":
    raise SystemExit(main())
