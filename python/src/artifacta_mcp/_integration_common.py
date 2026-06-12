"""Shared helpers for the framework-integration wrappers.

Both `artifacta_mcp.openai_agents` and `artifacta_mcp.langchain` launch the
published Artifacta MCP stdio server as a subprocess. The launch parameters
(command / args / env, including the `--allow-path` / `--allow-destructive`
flag translation) are identical across frameworks, so they live here rather
than being duplicated per wrapper.

This module has **no** third-party dependency — it only builds a dict — so it
imports cleanly regardless of which optional integration extras are installed.
"""
from __future__ import annotations

import os
import shutil
import sys
from collections.abc import Sequence
from typing import Any

__all__ = ["ARTIFACTA_MCP_COMMAND", "build_stdio_params"]

# The console script installed by this same package (see pyproject
# [project.scripts]). This is *not* the default launch command anymore — the
# default invokes the server via the current interpreter
# (``sys.executable -m artifacta_mcp.cli``) so it works even in notebooks / IDE
# kernels where the package is importable but its scripts directory is not on
# PATH. The constant is kept for callers who deliberately want the console
# script (e.g. ``command=ARTIFACTA_MCP_COMMAND``) or pipx
# (``command="pipx", args=["run", "artifacta-mcp"]``).
ARTIFACTA_MCP_COMMAND = "artifacta-mcp"

# Module entry equivalent to the console script. `python -m artifacta_mcp.cli`
# runs cli.py's `if __name__ == "__main__"` guard → `main()`, so it accepts the
# exact same `--allow-path` / `--allow-destructive` argv the script does.
_MODULE_ARGS = ["-m", "artifacta_mcp.cli"]

# Env vars that may not be set via ``extra_env`` — these are resolved from the
# dedicated ``api_key`` / ``api_url`` arguments (which fall back to the parent
# environment), and letting ``extra_env`` silently shadow them would make the
# resolved auth ambiguous. Blocked rather than ignored so a mistake is loud.
_RESERVED_ENV = {"ARTIFACTA_API_KEY", "ARTIFACTA_API_URL"}

# Process/system variables forwarded from the parent so the child can actually
# spawn and import. Deliberately a small allow-list — the child does NOT inherit
# the full parent environment, so unrelated secrets (OPENAI_API_KEY, cloud
# creds, CI tokens) and ambient Artifacta knobs (notably ARTIFACTA_MCP_ALLOW_PATH,
# whose allow-list MUST come only from `allow_path=` / `--allow-path`) never leak
# into the subprocess.
#
# POSIX: PATH (resolve interpreter / pipx), HOME, locale, temp dir.
# Windows: SystemRoot/SYSTEMROOT are required for Python to start at all;
#   USERPROFILE / TEMP / TMP keep config + temp resolution working.
# PYTHONPATH / PYTHONHOME: forwarded so editable / monorepo installs (where the
#   package lives on PYTHONPATH rather than site-packages) can import
#   artifacta_mcp under `-m`.
# Proxy / TLS: the server makes real HTTPS calls to api.artifacta.io via httpx
#   (trust_env=True), which reads these. Forwarding them is required so the
#   subprocess works behind a corporate proxy or with a custom CA bundle — these
#   are process-infrastructure config (like PATH/HOME), not app secrets.
_PASSTHROUGH_ENV_VARS = (
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "PYTHONPATH",
    "PYTHONHOME",
    "PYTHONIOENCODING",
    "PYTHONUTF8",
    # Proxy / TLS (so HTTPS API calls work behind a proxy / custom CA)
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
    "ALL_PROXY",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    # Windows
    "SystemRoot",
    "SYSTEMROOT",
    "SystemDrive",
    "USERPROFILE",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "PATHEXT",
    "COMSPEC",
)


def _normalize_allow_paths(allow_path: str | Sequence[str] | None) -> list[str]:
    if allow_path is None:
        return []
    if isinstance(allow_path, str):
        return [allow_path]
    return list(allow_path)


def _build_child_env(resolved_key: str, resolved_url: str | None) -> dict[str, str]:
    """Build a minimal, sanitized child environment.

    Starts from a fixed allow-list of process/system vars (never the full parent
    environment), then sets the resolved Artifacta auth values. See
    ``_PASSTHROUGH_ENV_VARS`` for the rationale on what crosses over.
    """
    env: dict[str, str] = {}
    for var in _PASSTHROUGH_ENV_VARS:
        value = os.environ.get(var)
        if value is not None:
            env[var] = value
    env["ARTIFACTA_API_KEY"] = resolved_key
    if resolved_url:
        env["ARTIFACTA_API_URL"] = resolved_url
    return env


def build_stdio_params(
    *,
    api_key: str | None = None,
    api_url: str | None = None,
    allow_path: str | Sequence[str] | None = None,
    allow_destructive: bool = False,
    command: str | None = None,
    args: Sequence[str] | None = None,
    extra_env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Build the stdio launch parameters for the Artifacta MCP server.

    Pure function — no third-party imports — so it is fully unit-testable
    without any optional integration dependency. Returns a dict shaped for both
    `agents.mcp.MCPServerStdio(params=...)` and `mcp.StdioServerParameters(**...)`:
    ``{"command", "args", "env"}``.

    Arguments:

    - ``api_key`` defaults to ``$ARTIFACTA_API_KEY``; raises ``ValueError`` if
      neither is provided (a clear failure here beats an opaque subprocess
      auth error later).
    - ``api_url`` defaults to ``$ARTIFACTA_API_URL`` if set (else the server's
      production default is used).
    - ``allow_path`` appends one ``--allow-path <dir>`` pair per entry. This is
      the **only** way to widen the server's path allow-list — the ambient
      ``ARTIFACTA_MCP_ALLOW_PATH`` env var is intentionally not forwarded.
    - ``allow_destructive`` appends ``--allow-destructive`` when ``True``.
    - ``command`` defaults to ``sys.executable`` launched as
      ``-m artifacta_mcp.cli``, so the server runs even when the
      ``artifacta-mcp`` console script is not on ``PATH`` (notebooks, IDE
      kernels, embedded interpreters). Override for pipx / custom launches
      (e.g. ``command="pipx", args=["run", "artifacta-mcp"]``); a bare override
      command not found on ``PATH`` raises ``ValueError`` up front.
    - ``args`` is a prefix prepended before the translated ``--allow-*`` flags.
    - ``extra_env`` adds environment variables to the (minimal) child env. It
      may not set ``ARTIFACTA_API_KEY`` / ``ARTIFACTA_API_URL`` (raises
      ``ValueError``) — those are resolved from the dedicated arguments.

    Environment contract: the child does **not** inherit the parent
    environment. Only a fixed allow-list of process/system vars (``PATH``,
    ``HOME``, locale, temp dir, ``PYTHONPATH``, plus Windows essentials) crosses
    over, alongside the resolved ``ARTIFACTA_API_KEY`` / ``ARTIFACTA_API_URL``.
    Everything else — unrelated secrets and ambient Artifacta MCP knobs
    (``ARTIFACTA_MCP_ALLOW_PATH``, ``ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM``) —
    must be passed deliberately via ``extra_env``.
    """
    resolved_key = api_key if api_key is not None else os.environ.get("ARTIFACTA_API_KEY")
    if not resolved_key:
        raise ValueError(
            "No Artifacta API key. Pass api_key=... or set ARTIFACTA_API_KEY. "
            "Obtain a key at https://app.artifacta.io/dashboard/keys."
        )

    resolved_url = api_url if api_url is not None else os.environ.get("ARTIFACTA_API_URL")

    env = _build_child_env(resolved_key, resolved_url)
    if extra_env:
        reserved = _RESERVED_ENV & set(extra_env)
        if reserved:
            raise ValueError(
                "extra_env may not set "
                + ", ".join(sorted(reserved))
                + " — pass api_key=/api_url= instead."
            )
        env.update(extra_env)

    # Resolve the launch command + base args. Default: run via the current
    # interpreter (PATH-independent). An explicit override supplies its own args.
    if command is None:
        resolved_command = sys.executable
        base_args: list[str] = list(_MODULE_ARGS)
    else:
        resolved_command = command
        base_args = []
        # A bare command name (no path separator, not the running interpreter)
        # must resolve on PATH or the subprocess spawn fails opaquely later.
        if os.sep not in command and (os.altsep is None or os.altsep not in command):
            if command != sys.executable and shutil.which(command) is None:
                raise ValueError(
                    f"Launch command {command!r} was not found on PATH. "
                    "Install it, pass an absolute path, or omit command= to use "
                    "the current interpreter (python -m artifacta_mcp.cli)."
                )

    launch_args: list[str] = base_args + (list(args) if args is not None else [])
    for path in _normalize_allow_paths(allow_path):
        launch_args.extend(["--allow-path", path])
    if allow_destructive:
        launch_args.append("--allow-destructive")

    return {"command": resolved_command, "args": launch_args, "env": env}
