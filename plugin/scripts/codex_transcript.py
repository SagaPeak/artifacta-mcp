#!/usr/bin/env python3
"""Safe Codex rollout discovery, snapshotting, and one-shot capture state."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, BinaryIO

MAX_CONTENT_BYTES = 10 * 1024 * 1024
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class TranscriptError(RuntimeError):
    """A safe, user-actionable transcript operation failure."""


def _validate_session_id(session_id: str) -> str:
    if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
        raise TranscriptError("invalid Codex session identity")
    return session_id


def _validate_regular_file(path: Path) -> Path:
    path = Path(path).expanduser()
    try:
        info = path.lstat()
    except OSError as exc:
        raise TranscriptError(f"transcript file is unavailable: {path}") from exc
    if stat.S_ISLNK(info.st_mode):
        raise TranscriptError(f"transcript file must not be a symlink: {path}")
    if not stat.S_ISREG(info.st_mode):
        raise TranscriptError(f"transcript path is not a regular file: {path}")
    return path


def _open_regular_read(path: Path) -> BinaryIO:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise TranscriptError(f"transcript file could not be opened safely: {path}") from exc
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode):
        os.close(descriptor)
        raise TranscriptError(f"transcript path is not a regular file: {path}")
    return os.fdopen(descriptor, "rb")


def _contains_exact_bytes(path: Path, phrase: bytes) -> bool:
    overlap = max(0, len(phrase) - 1)
    previous = b""
    with _open_regular_read(path) as handle:
        while chunk := handle.read(64 * 1024):
            combined = previous + chunk
            if phrase in combined:
                return True
            previous = combined[-overlap:] if overlap else b""
    return False


def _ensure_private_directory(path: Path, label: str) -> Path:
    directory = Path(path).expanduser()
    try:
        info = directory.lstat()
    except FileNotFoundError:
        try:
            directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        except FileExistsError:
            info = directory.lstat()
        else:
            info = directory.lstat()
    except OSError as exc:
        raise TranscriptError(f"{label} is unavailable") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise TranscriptError(f"{label} must be a real directory, not a symlink")
    os.chmod(directory, 0o700)
    return directory


def discover_transcript(codex_home: Path, phrase: str) -> Path:
    """Find exactly one regular rollout containing the exact phrase."""
    if not isinstance(phrase, str) or not phrase:
        raise TranscriptError("a non-empty distinctive phrase is required")
    sessions = Path(codex_home).expanduser() / "sessions"
    candidates: list[Path] = []
    if sessions.is_dir():
        for candidate in sessions.rglob("*.jsonl"):
            try:
                safe_candidate = _validate_regular_file(candidate)
                if _contains_exact_bytes(safe_candidate, phrase.encode("utf-8")):
                    candidates.append(safe_candidate)
            except TranscriptError:
                continue
    if len(candidates) != 1:
        raise TranscriptError(
            f"expected exactly one verified Codex transcript, found {len(candidates)}"
        )
    return candidates[0]


def inspect_transcript(path: Path) -> dict[str, Any]:
    """Return sanitized identity and model metadata from a Codex rollout."""
    safe_path = _validate_regular_file(Path(path))
    session_id: str | None = None
    models: list[str] = []

    with _open_regular_read(safe_path) as handle:
        for raw_line in handle:
            try:
                record = json.loads(raw_line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if not isinstance(record, dict):
                continue
            record_type = record.get("type")
            payload = record.get("payload")
            if not isinstance(payload, dict):
                continue
            if record_type == "session_meta" and session_id is None:
                candidate_id = payload.get("id")
                if isinstance(candidate_id, str) and SESSION_ID_RE.fullmatch(candidate_id):
                    session_id = candidate_id
            elif record_type == "turn_context":
                model = payload.get("model")
                if isinstance(model, str) and model and model != "<synthetic>":
                    models.append(model)

    if session_id is None:
        raise TranscriptError("transcript has no valid Codex session identity")

    distinct_models = list(dict.fromkeys(models))
    result: dict[str, Any] = {
        "session_id": session_id,
        "transcript_path": str(safe_path),
        "size_bytes": safe_path.stat().st_size,
    }
    if models:
        result["model"] = models[-1]
        result["models_used"] = distinct_models
    return result


def create_snapshot(path: Path, output_dir: Path | None = None) -> dict[str, Any]:
    """Copy a verified rollout to a private snapshot and return safe metadata."""
    safe_path = _validate_regular_file(Path(path))
    metadata = inspect_transcript(safe_path)
    size_bytes = safe_path.stat().st_size
    if size_bytes > MAX_CONTENT_BYTES:
        raise TranscriptError(
            f"transcript is {size_bytes} bytes, over the hosted MCP inline limit"
        )

    destination_dir = (
        Path(output_dir).expanduser()
        if output_dir is not None
        else Path(tempfile.gettempdir()) / "artifacta-transcripts"
    )
    destination_dir = _ensure_private_directory(
        destination_dir, "snapshot directory"
    )
    descriptor, snapshot_name = tempfile.mkstemp(
        prefix=f"transcript-{metadata['session_id']}-",
        suffix=".jsonl",
        dir=destination_dir,
    )
    snapshot_path = Path(snapshot_name)
    digest = hashlib.sha256()
    copied_bytes = 0
    try:
        os.fchmod(descriptor, 0o600)
        with _open_regular_read(safe_path) as source, os.fdopen(
            descriptor, "wb", closefd=True
        ) as destination:
            while chunk := source.read(64 * 1024):
                destination.write(chunk)
                digest.update(chunk)
                copied_bytes += len(chunk)
                if copied_bytes > MAX_CONTENT_BYTES:
                    raise TranscriptError(
                        "transcript grew over the hosted MCP inline limit while snapshotting"
                    )
            destination.flush()
            os.fsync(destination.fileno())
    except Exception:
        snapshot_path.unlink(missing_ok=True)
        raise

    sha256 = digest.hexdigest()
    result = dict(metadata)
    result.update(
        {
            "snapshot_path": str(snapshot_path),
            "size_bytes": copied_bytes,
            "sha256": sha256,
            "idempotency_key": (
                f"codex-transcript:{metadata['session_id']}:{sha256}"
            ),
        }
    )
    return result


def default_state_root() -> Path:
    codex_home = os.environ.get("CODEX_HOME")
    base = Path(codex_home).expanduser() if codex_home else Path.home() / ".codex"
    return base / "artifacta" / "transcript-capture"


def _state_root(path: Path | None) -> Path:
    root = Path(path).expanduser() if path is not None else default_state_root()
    return _ensure_private_directory(root, "capture state directory")


def _marker_path(session_id: str, state_root: Path | None) -> Path:
    return _state_root(state_root) / f"{_validate_session_id(session_id)}.json"


def _read_marker(path: Path) -> dict[str, Any] | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise TranscriptError("capture marker is unavailable") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise TranscriptError("capture marker is not a safe regular file")
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise TranscriptError("capture marker is malformed") from exc
    if not isinstance(value, dict):
        raise TranscriptError("capture marker is malformed")
    if value.get("state") not in {"armed", "triggered"}:
        raise TranscriptError("capture marker has an invalid state")
    _validate_session_id(value.get("session_id"))
    if not isinstance(value.get("transcript_path"), str):
        raise TranscriptError("capture marker has no transcript path")
    return value


def _write_marker(path: Path, value: dict[str, Any]) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.stem}-", suffix=".tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        payload = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def arm_capture(
    session_id: str, transcript_path: Path, state_root: Path | None = None
) -> dict[str, Any]:
    session_id = _validate_session_id(session_id)
    safe_transcript = _validate_regular_file(Path(transcript_path)).resolve()
    inspected = inspect_transcript(safe_transcript)
    if inspected["session_id"] != session_id:
        raise TranscriptError("marker session does not match transcript identity")
    marker_path = _marker_path(session_id, state_root)
    existing = _read_marker(marker_path)
    if existing is not None:
        if Path(existing["transcript_path"]) != safe_transcript:
            raise TranscriptError(
                "an active marker for this session references a different transcript"
            )
        if existing["state"] == "armed":
            return existing

    marker = {
        "session_id": session_id,
        "transcript_path": str(safe_transcript),
        "state": "armed",
        "created_at": datetime.now(UTC).isoformat(),
    }
    _write_marker(marker_path, marker)
    return marker


def status_capture(
    session_id: str, state_root: Path | None = None
) -> dict[str, Any] | None:
    return _read_marker(_marker_path(session_id, state_root))


def trigger_capture(
    session_id: str, state_root: Path | None = None
) -> dict[str, Any] | None:
    marker_path = _marker_path(session_id, state_root)
    lock_path = marker_path.with_name(f".{marker_path.stem}.lock")
    try:
        lock_descriptor = os.open(
            lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600
        )
    except FileExistsError:
        return None
    try:
        os.close(lock_descriptor)
        marker = _read_marker(marker_path)
        if marker is None or marker["state"] != "armed":
            return None
        triggered = dict(marker)
        triggered["state"] = "triggered"
        triggered["triggered_at"] = datetime.now(UTC).isoformat()
        _write_marker(marker_path, triggered)
        return triggered
    finally:
        lock_path.unlink(missing_ok=True)


def complete_capture(session_id: str, state_root: Path | None = None) -> bool:
    marker_path = _marker_path(session_id, state_root)
    marker = _read_marker(marker_path)
    if marker is None or marker["state"] != "triggered":
        return False
    marker_path.unlink()
    return True


def reset_capture(session_id: str, state_root: Path | None = None) -> bool:
    marker_path = _marker_path(session_id, state_root)
    if _read_marker(marker_path) is None:
        return False
    marker_path.unlink()
    return True


def _emit(value: Any) -> None:
    print(json.dumps(value, separators=(",", ":"), sort_keys=True))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    discover = subparsers.add_parser("discover")
    discover.add_argument("--phrase", required=True)
    discover.add_argument("--codex-home", type=Path)

    inspect = subparsers.add_parser("inspect")
    inspect.add_argument("--transcript", required=True, type=Path)

    snapshot = subparsers.add_parser("snapshot")
    snapshot.add_argument("--transcript", required=True, type=Path)
    snapshot.add_argument("--output-dir", type=Path)

    for name in ("arm", "status", "trigger", "complete", "reset"):
        command = subparsers.add_parser(name)
        command.add_argument("--session-id", required=True)
        command.add_argument("--state-root", type=Path)
        if name == "arm":
            command.add_argument("--transcript", required=True, type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "discover":
            codex_home = args.codex_home or (
                Path(os.environ["CODEX_HOME"])
                if os.environ.get("CODEX_HOME")
                else Path.home() / ".codex"
            )
            path = discover_transcript(codex_home, args.phrase)
            result = inspect_transcript(path)
            result["transcript_path"] = str(path)
        elif args.command == "inspect":
            result = inspect_transcript(args.transcript)
        elif args.command == "snapshot":
            result = create_snapshot(args.transcript, args.output_dir)
        elif args.command == "arm":
            result = arm_capture(
                args.session_id, args.transcript, args.state_root
            )
        elif args.command == "status":
            result = status_capture(args.session_id, args.state_root)
        elif args.command == "trigger":
            result = trigger_capture(args.session_id, args.state_root)
        elif args.command == "complete":
            result = {"completed": complete_capture(args.session_id, args.state_root)}
        else:
            result = {"reset": reset_capture(args.session_id, args.state_root)}
    except TranscriptError as exc:
        print(f"artifacta transcript: {exc}", file=sys.stderr)
        return 2
    _emit(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
