#!/usr/bin/env python3
import argparse
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_MODEL = "ollama/gemma4:e4b-it-qat"


def find_pi(explicit):
    candidates = [
        explicit,
        os.environ.get("PI_BIN"),
        str(Path.home() / ".local/bin/pi"),
        str(Path.home() / ".pi/agent/bin/pi"),
        shutil.which("pi"),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
        found = shutil.which(candidate)
        if found:
            return found
    raise SystemExit("no pi executable found")


def newest_session(session_dir):
    files = list(Path(session_dir).glob("*.jsonl"))
    if not files:
        return None
    return max(files, key=lambda item: item.stat().st_mtime)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", required=True)
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--pi")
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args()

    work = Path(args.work).expanduser().resolve()
    sessions = work / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    prompt = Path(args.prompt_file).expanduser().read_text()
    command = [
        find_pi(args.pi),
        "-p",
        "--model",
        args.model,
        "--session-dir",
        str(sessions),
        "--session" if args.resume else "--session-id",
        args.session_id,
        "--",
        prompt,
    ]
    wrapped = ["script", "-qec", " ".join(shlex.quote(part) for part in command), "/dev/null"]
    result = subprocess.run(wrapped, cwd=work, timeout=args.timeout)
    session = newest_session(sessions)
    print(f"PI_EXIT={result.returncode}")
    print(f"PI_SESSION={session}")
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
