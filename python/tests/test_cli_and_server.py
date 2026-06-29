"""CLI + server bootstrap smoke tests."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from artifacta_mcp import __version__, safety

REPO_ROOT = Path(__file__).resolve().parent.parent
SDK_SRC = (REPO_ROOT / ".." / ".." / "cli" / "src").resolve()
PKG_SRC = REPO_ROOT / "src"


def _env_with_paths(extra: dict[str, str] | None = None) -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = f"{PKG_SRC}{os.pathsep}{SDK_SRC}"
    env.update(extra or {})
    return env


def test_cli_version_subprocess():
    result = subprocess.run(
        [sys.executable, "-m", "artifacta_mcp.cli", "--version"],
        env=_env_with_paths(),
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == __version__


def test_cli_help_subprocess():
    result = subprocess.run(
        [sys.executable, "-m", "artifacta_mcp.cli", "--help"],
        env=_env_with_paths(),
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0
    assert "Usage: artifacta-mcp" in result.stdout
    assert "--allow-destructive" in result.stdout
    assert "--allow-path" in result.stdout


def test_cli_refuses_without_api_key():
    env = _env_with_paths()
    env.pop("ARTIFACTA_API_KEY", None)
    result = subprocess.run(
        [sys.executable, "-c", "from artifacta_mcp.cli import main; import sys; sys.exit(main([]))"],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 2
    assert "ARTIFACTA_API_KEY" in result.stderr


def test_cli_main_constructs_client_and_registers_tools(monkeypatch):
    """Regression for the Codex finding: cli.main passed `api_url=` to the SDK
    Client which raised TypeError. This test exercises the full main() path
    with a valid API key, monkeypatching serve_stdio so we don't actually open
    a session, and asserts (a) the Client was constructed without TypeError,
    (b) all 13 tools registered, (c) main returned 0.

    Run in-process (not subprocess) so we can monkeypatch serve_stdio.
    """
    from artifacta_mcp import cli, client_factory, safety

    monkeypatch.setenv("ARTIFACTA_API_KEY", "ak_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")
    monkeypatch.setenv("ARTIFACTA_API_URL", "https://api.staging.artifacta.io")
    safety.clear_registry()
    client_factory.reset_client()

    # Capture the asyncio.run call so serve_stdio is never actually invoked.
    served: dict[str, object] = {}

    def fake_asyncio_run(coro):
        served["coro"] = coro
        coro.close()
        return None

    monkeypatch.setattr(cli.asyncio, "run", fake_asyncio_run)

    rc = cli.main([])

    assert rc == 0
    # Client was built via the correct constructor kwarg — if api_url had
    # still been passed by name, Client(api_key=, api_url=) would have
    # raised TypeError and main() would never have reached the run.
    client = client_factory.get_client()
    assert client is not None
    # All 13 tools registered — proves register_all_tools ran post-Client.
    assert len(safety.all_registrations()) == 13
    assert "coro" in served


def test_cli_main_refuses_with_incompatible_sdk(monkeypatch, capsys):
    """Defence-in-depth: if the dependency floor is somehow bypassed and an
    SDK without one of the required methods is installed, the server must
    refuse to start with a clear, actionable error — NOT fall through and
    crash at the first tool call.

    We simulate the old-SDK case by monkeypatching check_sdk_compatibility
    to report a missing method, then assert main() returns 2 and writes the
    upgrade hint to stderr (not stdout — stderr is the MCP host's log sink).
    """
    from artifacta_mcp import cli, client_factory, safety

    monkeypatch.setenv("ARTIFACTA_API_KEY", "ak_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")
    safety.clear_registry()
    client_factory.reset_client()

    fake_error = (
        "[artifacta-mcp] refusing to start: installed artifacta-cli is missing "
        "required Client method(s): request_upload_url. Upgrade with: pip install "
        "--upgrade 'artifacta-cli>=0.3.0,<2.0.0' (or, if pipx-installed: pipx "
        "upgrade artifacta-mcp)."
    )
    # Patch on the sdk_compat module — cli.py does a local import.
    from artifacta_mcp import sdk_compat

    monkeypatch.setattr(sdk_compat, "check_sdk_compatibility", lambda _cls: fake_error)

    rc = cli.main([])

    captured = capsys.readouterr()
    assert rc == 2, "main() must exit 2 when the SDK is incompatible"
    assert fake_error in captured.err
    assert captured.out == "", "compat error must go to stderr, not stdout"
    # Crucially: no Client was constructed and no tools were registered.
    assert len(safety.all_registrations()) == 0
    import pytest as _pytest
    with _pytest.raises(RuntimeError):
        client_factory.get_client()


# ---------------------------------------------------------------------------
# Server bootstrap — wire the safety registry to the mcp SDK
# ---------------------------------------------------------------------------


def _ensure_registered():
    safety.clear_registry()
    from artifacta_mcp.tools import register_all_tools

    register_all_tools()


def test_build_server_exposes_safe_tools_to_noncompliant_client():
    """list_tools handler returns the right surface when no confirmations capability."""
    _ensure_registered()
    from artifacta_mcp.server import build_server

    build_server(allow_destructive=False, write_confirm_required=False)
    # The handler reads server.request_context, which only exists inside a real
    # session. Drive the unit-level filter directly via safety.get_filtered_tools —
    # the server wiring is exercised by the integration smoke (live stdio) which
    # we do not run in CI without staging credentials.
    from artifacta_mcp.safety import FilterOpts, get_filtered_tools

    tools = get_filtered_tools(
        FilterOpts(has_confirmations=False, allow_destructive=False, write_confirm_required=False)
    )
    names = {t["name"] for t in tools}
    # Destructive tools absent for non-compliant clients without --allow-destructive
    assert "delete_artifact" not in names
    assert "seal_session" not in names
    assert "create_download_link" not in names
    # Read tools always visible
    assert {"whoami", "list_artifacts", "get_artifact", "get_artifact_download_url", "list_sessions"} <= names


def test_build_server_exposes_destructive_with_allow_destructive():
    _ensure_registered()
    from artifacta_mcp.safety import FilterOpts, get_filtered_tools

    tools = get_filtered_tools(
        FilterOpts(has_confirmations=False, allow_destructive=True, write_confirm_required=False)
    )
    names = {t["name"] for t in tools}
    assert "delete_artifact" in names
    assert "seal_session" in names
    assert "create_download_link" in names


def test_build_server_promotes_writes_under_env_for_compliant():
    _ensure_registered()
    from artifacta_mcp.safety import FilterOpts, get_filtered_tools

    tools = get_filtered_tools(
        FilterOpts(has_confirmations=True, allow_destructive=False, write_confirm_required=True)
    )
    sa = next(t for t in tools if t["name"] == "store_artifact")
    assert sa["_meta"]["requiresConfirmation"] is True
    cu = next(t for t in tools if t["name"] == "complete_upload")
    assert cu["_meta"]["requiresConfirmation"] is True


def test_build_server_compliant_destructive_carries_requires_confirmation():
    _ensure_registered()
    from artifacta_mcp.safety import FilterOpts, get_filtered_tools

    tools = get_filtered_tools(
        FilterOpts(has_confirmations=True, allow_destructive=False, write_confirm_required=False)
    )
    dt = next(t for t in tools if t["name"] == "delete_artifact")
    assert dt["_meta"]["requiresConfirmation"] is True
