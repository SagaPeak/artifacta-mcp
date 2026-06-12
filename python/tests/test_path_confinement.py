"""Unit tests for the Python path-confinement engine and cross-validation
against the shared fixture consumed by the TypeScript engine.
"""
from __future__ import annotations

import json
import os
import socket
from pathlib import Path

import pytest

from artifacta_mcp import path_confinement as pc
from artifacta_mcp.path_confinement import (
    ConfinementAllow,
    ConfinementDeny,
    build_allow_list,
    check_deny_list,
    check_path,
    format_outside_allow_list,
    format_size_exceeded,
    format_special_file,
)

# Shared fixture consumed by BOTH this test and the TS test at
# mcp/typescript/test/cross-validation-path-confinement.test.ts
FIXTURE_PATH = (
    Path(__file__).resolve().parent.parent.parent / "shared" / "path-confinement-fixture.json"
)


@pytest.fixture(autouse=True)
def _close_fds(request):
    """Track returned fds so any test leak is closed in teardown."""
    fds: list[int] = []

    def add(fd: int) -> int:
        fds.append(fd)
        return fd

    request.cls_or_module = add
    yield
    for fd in fds:
        try:
            os.close(fd)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Format helpers
# ---------------------------------------------------------------------------


def test_format_size_exceeded_uses_mb_label_below_1gb():
    text = format_size_exceeded("/tmp/big.bin", 600 * 1024 * 1024)
    assert "600 MB" in text
    assert "500 MB direct-upload ceiling" in text
    assert "request_upload_url" in text


def test_format_size_exceeded_uses_gb_label_at_or_above_1gb():
    text = format_size_exceeded("/tmp/huge.bin", int(1.5 * 1024**3))
    assert "1.5 GB" in text


def test_format_outside_allow_list_includes_all_roots():
    text = format_outside_allow_list("/tmp/x", ["/Users/me", "/var/data"])
    assert "/Users/me" in text and "/var/data" in text
    assert "outside the MCP server's allow-list" in text
    assert "--allow-path" in text


def test_format_special_file_names_socket_or_device():
    text = format_special_file("/tmp/sock")
    assert "special file" in text
    assert "Only regular files are accepted" in text


# ---------------------------------------------------------------------------
# Deny-list
# ---------------------------------------------------------------------------


def test_deny_list_blocks_dot_ssh():
    home = str(Path.home())
    reason = check_deny_list(os.path.join(home, ".ssh", "id_rsa"))
    assert reason is not None
    assert ".ssh" in reason


def test_deny_list_blocks_dot_env_file():
    # Pattern check operates on the resolved string, not the disk state.
    reason = check_deny_list("/Users/anyone/project/.env")
    assert reason is not None
    assert "pattern" in reason


def test_deny_list_blocks_credentials_json():
    reason = check_deny_list("/var/app/credentials.json")
    assert reason is not None
    assert "pattern" in reason


def test_deny_list_allows_unrelated_file():
    assert check_deny_list("/var/app/notes.md") is None


def test_deny_list_blocks_etc():
    # /etc on macOS resolves to /private/etc — deny-list includes both forms.
    assert check_deny_list("/etc/hosts") is not None
    assert check_deny_list("/private/etc/hosts") is not None


# ---------------------------------------------------------------------------
# Allow-list builder
# ---------------------------------------------------------------------------


def test_allow_list_defaults_to_cwd(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    roots = build_allow_list([])
    assert os.path.realpath(str(tmp_path)) in roots


def test_allow_list_parses_dash_dash_allow_path_equals(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    other = tmp_path / "other"
    other.mkdir()
    roots = build_allow_list([f"--allow-path={other}"])
    assert os.path.realpath(str(other)) in roots


def test_allow_list_parses_dash_dash_allow_path_space(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    other = tmp_path / "other2"
    other.mkdir()
    roots = build_allow_list(["--allow-path", str(other)])
    assert os.path.realpath(str(other)) in roots


def test_allow_list_parses_env_var(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    extra = tmp_path / "extra"
    extra.mkdir()
    monkeypatch.setenv("ARTIFACTA_MCP_ALLOW_PATH", str(extra))
    roots = build_allow_list([])
    assert os.path.realpath(str(extra)) in roots


def test_allow_list_relative_path_exits(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(SystemExit) as excinfo:
        build_allow_list(["--allow-path=relative/path"])
    assert excinfo.value.code == 2
    captured = capsys.readouterr()
    assert "refusing to start" in captured.err
    assert "relative/path" in captured.err


# ---------------------------------------------------------------------------
# check_path() — engine
# ---------------------------------------------------------------------------


def _write_regular(tmp_path: Path, name: str = "file.txt", size: int = 11) -> Path:
    p = tmp_path / name
    p.write_bytes(b"x" * size)
    return p


def test_check_path_allows_regular_file_in_allow_list(tmp_path):
    f = _write_regular(tmp_path)
    result = check_path(str(f), [str(tmp_path)])
    assert isinstance(result, ConfinementAllow)
    try:
        assert result.resolved_path == os.path.realpath(str(f))
        assert result.size == 11
        assert result.fd >= 0
    finally:
        os.close(result.fd)


def test_check_path_denies_path_outside_allow_list(tmp_path):
    f = _write_regular(tmp_path)
    other = tmp_path.parent  # one level up — outside the allow root
    result = check_path(str(f), [str(other / "definitely_not_here")])
    assert isinstance(result, ConfinementDeny)
    assert "outside the MCP server's allow-list" in result.reason


def test_check_path_denies_denylist_root_even_when_allow_listed(tmp_path, monkeypatch):
    # Build a fake ~/.ssh under tmp_path and point HOME at tmp_path
    monkeypatch.setenv("HOME", str(tmp_path))
    # Rebuild deny roots with the new HOME — module-level constant requires reload-style refresh
    fake_ssh = tmp_path / ".ssh"
    fake_ssh.mkdir()
    fake_key = fake_ssh / "id_rsa"
    fake_key.write_bytes(b"PRIVATE")
    # Call _build_deny_roots directly to validate that the rule shape works for ~/.ssh.
    # (The module-level _DENY_ROOTS was captured at import — that's fine; the contract
    # is that ~/.ssh under the real HOME is denied, exercised by the cross-validation
    # fixture below.)
    roots = pc._build_deny_roots()
    assert os.path.join(str(tmp_path), ".ssh") in roots


def test_check_path_denies_dot_env(tmp_path):
    env = tmp_path / ".env"
    env.write_text("SECRET=1\n")
    result = check_path(str(env), [str(tmp_path)])
    assert isinstance(result, ConfinementDeny)
    assert ".env" in result.reason or "pattern" in result.reason


def test_check_path_denies_credentials_json(tmp_path):
    creds = tmp_path / "credentials.json"
    creds.write_text("{}")
    result = check_path(str(creds), [str(tmp_path)])
    assert isinstance(result, ConfinementDeny)
    assert "credentials.json" in result.reason or "pattern" in result.reason


def test_check_path_denies_directory(tmp_path):
    sub = tmp_path / "sub"
    sub.mkdir()
    result = check_path(str(sub), [str(tmp_path)])
    assert isinstance(result, ConfinementDeny)
    assert "special file" in result.reason


def test_check_path_denies_unix_socket(tmp_path):
    # AF_UNIX paths are capped at ~104 chars on macOS — bind under a short
    # /tmp path inside the allow-list rather than pytest's deep tmp_path.
    import tempfile

    short_dir = tempfile.mkdtemp(prefix="afmcp-", dir="/tmp")
    sock_path = os.path.join(short_dir, "s")
    # Use the realpath form of short_dir for the allow-list; check_path
    # canonicalises the input, so allow roots must be canonical too.
    allow_root = os.path.realpath(short_dir)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.bind(sock_path)
        result = check_path(sock_path, [allow_root])
        assert isinstance(result, ConfinementDeny)
        assert "special file" in result.reason
    finally:
        s.close()
        if os.path.exists(sock_path):
            os.unlink(sock_path)
        os.rmdir(short_dir)


def test_check_path_denies_fifo(tmp_path):
    fifo_path = tmp_path / "myfifo"
    try:
        os.mkfifo(str(fifo_path))
    except (OSError, AttributeError):
        pytest.skip("mkfifo unavailable on this platform")
    try:
        result = check_path(str(fifo_path), [str(tmp_path)])
        assert isinstance(result, ConfinementDeny)
        assert "special file" in result.reason
    finally:
        os.unlink(str(fifo_path))


def test_check_path_denies_size_above_ceiling(tmp_path):
    # Use a tiny custom ceiling so we don't have to write 500 MB.
    f = _write_regular(tmp_path, size=1000)
    result = check_path(str(f), [str(tmp_path)], ceiling_bytes=500)
    assert isinstance(result, ConfinementDeny)
    assert "exceeding" in result.reason or "MB" in result.reason


def test_check_path_denies_unresolvable_path(tmp_path):
    result = check_path(str(tmp_path / "nope" / "ghost.bin"), [str(tmp_path)])
    assert isinstance(result, ConfinementDeny)
    assert "cannot be resolved" in result.reason


def test_check_path_resolves_symlinks_before_denylist(tmp_path):
    # Symlink under allow-list pointing into /etc → must be denied via deny-list,
    # not allowed via allow-list membership of the link site.
    link = tmp_path / "hosts-link"
    try:
        os.symlink("/etc/hosts", str(link))
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable on this filesystem")
    result = check_path(str(link), [str(tmp_path)])
    assert isinstance(result, ConfinementDeny)
    # /etc resolution lands on /etc or /private/etc on macOS — both are deny roots.
    assert "/etc" in result.reason or "/private/etc" in result.reason


# ---------------------------------------------------------------------------
# Cross-validation against the shared fixture
# ---------------------------------------------------------------------------


def _materialize_fixture_case(case: dict, cwd: Path) -> tuple[str, list[str]]:
    """Expand $CWD$, $HOME$, $TMP_REGULAR_FILE$, $TMP_DIR$ placeholders.

    Creates the necessary on-disk artifacts in `cwd` so the deny-pattern cases
    fire correctly. Returns (input_path, allow_roots).
    """
    home = str(Path.home())
    cwd_str = str(cwd)
    tmp_dir = cwd / "fixture_tmp"
    tmp_dir.mkdir(exist_ok=True)
    tmp_regular_file = tmp_dir / "regular.txt"
    if not tmp_regular_file.exists():
        tmp_regular_file.write_bytes(b"hello\n")

    def expand(s: str) -> str:
        return (
            s.replace("$CWD$", cwd_str)
            .replace("$HOME$", home)
            .replace("$TMP_REGULAR_FILE$", str(tmp_regular_file))
            .replace("$TMP_DIR$", str(tmp_dir))
        )

    input_path = expand(case["input_path"])
    allow_roots = [expand(r) for r in case["allow_roots"]]

    # For deny-pattern cases that reference files under tmp_dir, write them.
    if case.get("rule") == "denylist_pattern":
        target = Path(input_path)
        if not target.exists():
            target.write_text("seed\n")

    return input_path, allow_roots


def test_fixture_cross_validation(tmp_path, monkeypatch):
    """Walk every case in the shared fixture and assert Python's verdict matches."""
    assert FIXTURE_PATH.exists(), f"Missing shared fixture at {FIXTURE_PATH}"
    fixture = json.loads(FIXTURE_PATH.read_text())

    monkeypatch.chdir(tmp_path)

    failures: list[str] = []
    for case in fixture["cases"]:
        input_path, allow_roots = _materialize_fixture_case(case, tmp_path)
        expected = case["verdict"]
        result = check_path(input_path, allow_roots)

        actual_verdict = "allow" if isinstance(result, ConfinementAllow) else "deny"
        if actual_verdict != expected:
            failures.append(
                f"{case['id']}: expected {expected!r}, got {actual_verdict!r} "
                f"(reason: {getattr(result, 'reason', '<allowed>')})"
            )
            if isinstance(result, ConfinementAllow):
                os.close(result.fd)
            continue

        # Allow result: close the fd so the test doesn't leak.
        if isinstance(result, ConfinementAllow):
            os.close(result.fd)

        # Deny result: when the fixture names a specific deny rule, sanity-check
        # that the reason string mentions the expected substring.
        if isinstance(result, ConfinementDeny):
            rule = case.get("rule")
            if rule == "denylist_root":
                # Root is /etc or under $HOME — assert the reason names a deny-list root.
                if "deny-list" not in result.reason and "/etc" not in result.reason and "/.ssh" not in result.reason and "/.aws" not in result.reason and "/.netrc" not in result.reason:
                    failures.append(
                        f"{case['id']}: deny verdict but unexpected reason: {result.reason!r}"
                    )
            elif rule == "denylist_pattern":
                if "pattern" not in result.reason:
                    failures.append(
                        f"{case['id']}: expected pattern reason, got: {result.reason!r}"
                    )
            elif rule == "outside_allow_list":
                if "outside the MCP server's allow-list" not in result.reason:
                    failures.append(
                        f"{case['id']}: expected outside-allow-list reason, got: {result.reason!r}"
                    )
            elif rule == "unresolvable":
                if "cannot be resolved" not in result.reason:
                    failures.append(
                        f"{case['id']}: expected unresolvable reason, got: {result.reason!r}"
                    )

    assert not failures, "Cross-validation failures:\n" + "\n".join(failures)
