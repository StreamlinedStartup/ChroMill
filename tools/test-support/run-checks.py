from helper_runtime import ROOT, arguments, output_directory, run, tmux_context, write


def main():
    parser = arguments("Capture fresh bounded mise task receipts")
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument("tasks", nargs="*", default=["test", "workflow-test", "lint", "typecheck", "build"])
    args = parser.parse_args()
    output = output_directory(args)
    receipts = []
    receipt = {"runId": args.run_id, "commands": receipts, "exitCode": 1}
    try:
        receipt.update(tmux_context())
        for task in args.tasks:
            if not task.replace("-", "").isalnum():
                raise ValueError("Invalid mise task name")
            receipts.append(run(["rtk", "proxy", "mise", "run", task], ROOT,
                                output / (task + ".log"), args.timeout))
            write(output / "commands.json", receipt)
        receipt["exitCode"] = int(any(item["exitCode"] != 0 for item in receipts))
    except Exception as error:
        receipt["error"] = str(error)
    finally:
        write(output / "commands.json", receipt)
    return receipt["exitCode"]


if __name__ == "__main__":
    raise SystemExit(main())
