"""Local path-confinement engine — Python port of mcp/typescript/src/path/.

This module is the authoritative gate before any tool reads a filesystem path
supplied by an agent. Semantics match the TypeScript engine exactly; the
cross-validation fixture in `mcp/shared/path-confinement-fixture.json` is the
contract enforced by both ports.

Resolution order (mirrors TS):
  1. Resolve symlinks (realpath).
  2. Deny-list check (built-in roots + filename patterns).
  3. Allow-list membership.
  4. Pre-open stat — catches special files (sockets, FIFOs, devices).
  5. open() with O_NOFOLLOW to close the TOCTOU window.
  6. fstat() via the open fd.
  7. Reject special files (race-resistant).
  8. Size ceiling.
"""
from __future__ import annotations

import os
import re
import stat as stat_module
import sys
from dataclasses import dataclass
from pathlib import Path

MAX_PATH_UPLOAD_BYTES = 500 * 1024 * 1024  # 500 MB — matches TS const

# O_NOFOLLOW is POSIX; fall back to 0 on Windows (matches the TS fallback).
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ConfinementAllow:
    """Successful confinement check.

    `fd` is an open file descriptor — caller MUST close it (or hand to
    `os.fdopen` / similar). Using the fd eliminates the TOCTOU window between
    path validation and file open.

    `size` / `mtime_ms` / `ino` are captured from the same fstat used for the
    size-ceiling check. Streaming callers should bound their read to `size`
    and re-verify size + mtime_ms before each (re)read so that a file
    mutated in place after the check cannot bypass the ceiling or break a
    byte-identical retry.
    """

    resolved_path: str
    fd: int
    size: int
    mtime_ms: float
    ino: int
    ok: bool = True


@dataclass(frozen=True)
class ConfinementDeny:
    reason: str
    ok: bool = False


ConfinementResult = ConfinementAllow | ConfinementDeny


# ---------------------------------------------------------------------------
# Format helpers — strings are part of the contract (TS path/format.ts)
# ---------------------------------------------------------------------------


def format_outside_allow_list(resolved_path: str, allow_roots: list[str]) -> str:
    root_list = ", ".join(allow_roots)
    return (
        f"invalid_request: Path '{resolved_path}' is outside the MCP server's allow-list.\n"
        f"Allow-listed roots: {root_list} (default: server CWD)\n"
        "Pass --allow-path=/Users/me/other-dir at launch to widen, or use the `content` field to send bytes inline."
    )


def format_denied(resolved_path: str, reason: str) -> str:
    return (
        f"invalid_request: Path '{resolved_path}' is outside the MCP server's allow-list.\n"
        f"{reason}"
    )


def format_size_exceeded(resolved_path: str, file_size_bytes: int) -> str:
    if file_size_bytes >= 1024**3:
        gb = file_size_bytes / (1024**3)
        size_label = f"{gb:.1f} GB"
    else:
        mb = file_size_bytes / (1024**2)
        size_label = f"{mb:.0f} MB"
    return (
        f"invalid_request: Path '{resolved_path}' is {size_label}, exceeding the 500 MB direct-upload ceiling for store_artifact.path. "
        "Use request_upload_url for files >500 MB on Pro."
    )


def format_special_file(resolved_path: str) -> str:
    return (
        f"invalid_request: Path '{resolved_path}' is a special file (socket, device, FIFO, or symlink to special). "
        "Only regular files are accepted."
    )


def format_relative_allow_path(entry: str) -> str:
    return (
        f"[artifacta-mcp] refusing to start: --allow-path entry '{entry}' is not an absolute path. "
        "All --allow-path and ARTIFACTA_MCP_ALLOW_PATH entries must be absolute paths."
    )


# ---------------------------------------------------------------------------
# Deny-list (TS path/denylist.ts)
# ---------------------------------------------------------------------------


def _build_deny_roots() -> list[str]:
    home = str(Path.home())
    return [
        os.path.join(home, ".ssh"),
        os.path.join(home, ".aws"),
        os.path.join(home, ".gnupg"),
        os.path.join(home, ".config", "gh"),
        os.path.join(home, ".kube"),
        os.path.join(home, ".artifacta"),
        os.path.join(home, ".netrc"),
        os.path.join(home, "Library", "Keychains"),
        "/etc",
        "/var/lib",
        "/proc",
        "/sys",
        "/dev",
        "/private/etc",
    ]


def _resolve_deny_root(root: str) -> str:
    try:
        return os.path.realpath(root)
    except OSError:
        return root


def _all_deny_roots() -> list[str]:
    raw = _build_deny_roots()
    resolved = [_resolve_deny_root(r) for r in raw]
    # De-dupe while preserving order (raw first, then any new resolutions)
    seen: set[str] = set()
    out: list[str] = []
    for r in [*raw, *resolved]:
        if r not in seen:
            seen.add(r)
            out.append(r)
    return out


_DENY_ROOTS = _all_deny_roots()

# Filename patterns matched against the resolved path (TS path/denylist.ts).
DENY_FILENAME_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"(?:^|/)credentials\.json$"),
    re.compile(r"(?:^|/)\.env(?:\.|$)"),
]


def check_deny_list(resolved_path: str) -> str | None:
    """Return the deny reason if path matches; None otherwise.

    `resolved_path` must already be canonicalized via os.path.realpath().
    """
    for root in _DENY_ROOTS:
        if resolved_path == root or resolved_path.startswith(root + "/"):
            return f"Path '{resolved_path}' matches built-in deny-list entry '{root}'"
    for pattern in DENY_FILENAME_PATTERNS:
        if pattern.search(resolved_path):
            return f"Path '{resolved_path}' matches deny-list filename pattern"
    return None


# ---------------------------------------------------------------------------
# Allow-list builder (TS path/confinement.ts:buildAllowList)
# ---------------------------------------------------------------------------


def _resolve_root(root: str) -> str:
    try:
        return os.path.realpath(root)
    except OSError:
        return root


def build_allow_list(argv: list[str]) -> list[str]:
    """Build allow-list from CWD + --allow-path args + ARTIFACTA_MCP_ALLOW_PATH env.

    Exits with code 2 if a relative path is found (matches TS behaviour).
    """
    roots: list[str] = [_resolve_root(os.getcwd())]

    i = 0
    while i < len(argv):
        arg = argv[i]
        value: str | None = None
        if arg.startswith("--allow-path="):
            value = arg[len("--allow-path=") :]
        elif arg == "--allow-path" and i + 1 < len(argv):
            i += 1
            value = argv[i]
        if value is not None:
            for entry in [e for e in value.split(":") if e]:
                if not os.path.isabs(entry):
                    sys.stderr.write(format_relative_allow_path(entry) + "\n")
                    sys.exit(2)
                roots.append(_resolve_root(entry))
        i += 1

    env_paths = os.environ.get("ARTIFACTA_MCP_ALLOW_PATH")
    if env_paths:
        for entry in [e for e in env_paths.split(":") if e]:
            if not os.path.isabs(entry):
                sys.stderr.write(format_relative_allow_path(entry) + "\n")
                sys.exit(2)
            roots.append(_resolve_root(entry))

    return roots


def log_allow_list(roots: list[str]) -> None:
    sys.stderr.write(f"[artifacta-mcp] path allow-list: {', '.join(roots)}\n")


# ---------------------------------------------------------------------------
# Engine — check_path()
# ---------------------------------------------------------------------------


def _is_regular_file(mode: int) -> bool:
    return stat_module.S_ISREG(mode)


def check_path(
    input_path: str,
    allow_roots: list[str],
    ceiling_bytes: int = MAX_PATH_UPLOAD_BYTES,
) -> ConfinementResult:
    """Validate a filesystem path against the allow-list, deny-list, and size ceiling.

    On success returns an open file descriptor; the caller MUST close it.
    On failure returns a refusal payload with a §4.4-compliant reason string.
    """
    # Step 1: resolve symlinks — detect deny/allow on the canonical path.
    try:
        resolved = os.path.realpath(input_path, strict=True)
    except OSError as err:
        return ConfinementDeny(
            reason=f"invalid_request: Path '{input_path}' cannot be resolved: {err.strerror or str(err)}"
        )

    # Step 2: deny-list — fast, no I/O.
    deny_reason = check_deny_list(resolved)
    if deny_reason is not None:
        return ConfinementDeny(reason=format_denied(resolved, deny_reason))

    # Step 3: allow-list membership — fast, no I/O.
    in_allow_list = any(
        resolved == root or resolved.startswith(root + "/") for root in allow_roots
    )
    if not in_allow_list:
        return ConfinementDeny(reason=format_outside_allow_list(resolved, allow_roots))

    # Step 3.5: pre-open stat — catches special files (sockets, FIFOs, devices)
    # whose open(O_RDONLY) would fail with EOPNOTSUPP/ENXIO before fstat
    # can classify them. The post-open fstat (step 6) stays as the
    # race-detection guard.
    try:
        early_stat = os.stat(resolved)
        if not _is_regular_file(early_stat.st_mode):
            return ConfinementDeny(reason=format_special_file(resolved))
    except OSError:
        # If stat throws (ENOENT, perm, etc.) fall through — open will surface
        # the more specific error.
        pass

    # Step 4: open with O_NOFOLLOW.
    try:
        fd = os.open(resolved, os.O_RDONLY | _O_NOFOLLOW)
    except OSError as err:
        return ConfinementDeny(
            reason=f"invalid_request: Path '{resolved}' cannot be opened: {err.strerror or str(err)}"
        )

    # Step 5: stat via fd — immune to any post-open race.
    try:
        st = os.fstat(fd)
    except OSError as err:
        os.close(fd)
        return ConfinementDeny(
            reason=f"invalid_request: Path '{resolved}' cannot be stat'd: {err.strerror or str(err)}"
        )

    # Step 6: reject special files.
    if not _is_regular_file(st.st_mode):
        os.close(fd)
        return ConfinementDeny(reason=format_special_file(resolved))

    # Step 7: size ceiling.
    if st.st_size > ceiling_bytes:
        os.close(fd)
        return ConfinementDeny(reason=format_size_exceeded(resolved, st.st_size))

    return ConfinementAllow(
        resolved_path=resolved,
        fd=fd,
        size=st.st_size,
        mtime_ms=st.st_mtime * 1000.0,
        ino=st.st_ino,
    )
