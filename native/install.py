"""Install only public paths and the actual unpacked extension ID."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import sys

NAME = "app.run_radar.windmill"


def install(directory, extension_id, fifo):
    if not re.fullmatch(r"[a-p]{32}", extension_id):
        raise ValueError("Use the actual 32-character extension ID from chrome://extensions.")
    if not fifo.is_absolute():
        raise ValueError("Use the absolute path to the existing 1Password FIFO.")
    directory.mkdir(parents=True, exist_ok=True)
    launcher = directory / (NAME + ".sh")
    manifest = directory / (NAME + ".json")
    if launcher.exists() or manifest.exists():
        raise ValueError("A helper is already registered. Remove it before installation.")
    command = [sys.executable, str(Path(__file__).with_name("host.py").resolve()), str(fifo), extension_id]
    launcher.write_text("#!/bin/sh\nexec " + shlex.join(command) + ' "$@"\n')
    os.chmod(launcher, 0o700)
    manifest.write_text(json.dumps({"name": NAME, "description": "Read-only ChroMill Windmill helper",
                                   "path": str(launcher.resolve()), "type": "stdio",
                                   "allowed_origins": ["chrome-extension://" + extension_id + "/"]}, indent=2))
    os.chmod(manifest, 0o600)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["install", "remove"])
    parser.add_argument("--extension-id")
    parser.add_argument("--fifo", type=Path)
    parser.add_argument("--directory", type=Path, default=Path.home() / "Library/Application Support/Google/Chrome/NativeMessagingHosts")
    args = parser.parse_args()
    try:
        if args.action == "install":
            if not args.extension_id or not args.fifo:
                parser.error("Installation needs --extension-id and --fifo.")
            install(args.directory.resolve(), args.extension_id, args.fifo)
        else:
            for suffix in (".json", ".sh"):
                (args.directory / (NAME + suffix)).unlink(missing_ok=True)
    except (ValueError, OSError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
