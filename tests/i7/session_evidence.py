#!/usr/bin/env python3
import argparse
import json
from pathlib import Path


def tool_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts)
    return ""


def newest_session(session_dir):
    files = list(Path(session_dir).expanduser().glob("*.jsonl"))
    if not files:
        return None
    return max(files, key=lambda item: item.stat().st_mtime)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-dir", required=True)
    args = parser.parse_args()

    session = newest_session(args.session_dir)
    if session is None:
        print("SESSION_FILE=None")
        print("COMPILE_PASS=false")
        print("PINS_PASS=false")
        return 1

    results = []
    with session.open() as handle:
        for line in handle:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("type") != "message":
                continue
            message = entry.get("message", {})
            if message.get("role") != "toolResult":
                continue
            results.append(
                (
                    str(message.get("toolName") or ""),
                    bool(message.get("isError")),
                    tool_text(message.get("content")),
                )
            )

    compile_pass = any(
        name == "compile" and not is_error and "COMPILE: PASS" in text
        for name, is_error, text in results
    )
    pins_pass = any(
        name in {"compile", "pincheck"} and not is_error and "PINS: PASS" in text
        for name, is_error, text in results
    )

    print(f"SESSION_FILE={session}")
    for name, is_error, text in results:
        excerpt = text.replace("\n", " | ")[:240]
        print(f"TOOL {name} isError={str(is_error).lower()} {excerpt}")
    print(f"COMPILE_PASS={str(compile_pass).lower()}")
    print(f"PINS_PASS={str(pins_pass).lower()}")
    return 0 if compile_pass and pins_pass else 1


if __name__ == "__main__":
    raise SystemExit(main())
