#!/usr/bin/env python3
"""Trigger one MCP-backed transcript continuation for an armed Codex session."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import codex_transcript  # noqa: E402


def _emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, separators=(",", ":"), sort_keys=True))


def _noop() -> int:
    _emit({})
    return 0


def main() -> int:
    try:
        value = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError):
        print("artifacta transcript hook: invalid hook input", file=sys.stderr)
        return 2
    if not isinstance(value, dict):
        print("artifacta transcript hook: invalid hook input", file=sys.stderr)
        return 2

    if value.get("hook_event_name") != "Stop" or value.get("stop_hook_active") is True:
        return _noop()

    session_id = value.get("session_id")
    if not isinstance(session_id, str):
        print("artifacta transcript hook: invalid session identity", file=sys.stderr)
        return 2

    try:
        marker = codex_transcript.status_capture(session_id)
    except codex_transcript.TranscriptError as exc:
        print(f"artifacta transcript hook: {exc}", file=sys.stderr)
        return 2
    if marker is None or marker["state"] != "armed":
        return _noop()

    transcript_path = value.get("transcript_path")
    if not isinstance(transcript_path, str) or not transcript_path:
        return _noop()
    supplied_path = Path(transcript_path).expanduser()
    try:
        safe_path = codex_transcript._validate_regular_file(supplied_path).resolve()
    except codex_transcript.TranscriptError:
        return _noop()
    if safe_path != Path(marker["transcript_path"]):
        return _noop()

    try:
        triggered = codex_transcript.trigger_capture(session_id)
    except codex_transcript.TranscriptError as exc:
        print(f"artifacta transcript hook: {exc}", file=sys.stderr)
        return 2
    if triggered is None:
        return _noop()

    reason = (
        f"Complete the armed one-shot Artifacta transcript capture for Codex session "
        f"{session_id}. Follow the Codex automatic continuation flow in the "
        f"artifacta:capture-transcript skill. Use "
        f"mcp__artifacta__store_artifact, never a local CLI, set metadata capture "
        f"to automatic_stop, and run the helper complete command only after the MCP "
        f"upload succeeds. Do not arm another capture."
    )
    _emit({"decision": "block", "reason": reason})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
