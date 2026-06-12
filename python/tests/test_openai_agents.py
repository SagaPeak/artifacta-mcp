"""Tests for the OpenAI Agents SDK wrapper (artifacta_mcp.openai_agents).

The OpenAI Agents SDK is an *optional* dependency and is NOT installed in CI,
so these tests must not require it. The param-building logic
(`build_stdio_params`) is a pure function with no SDK import and is tested
directly. `artifacta_mcp_server` / `register` are tested by injecting a fake
`agents.mcp` module into sys.modules (and by asserting the clean ImportError
when the SDK is absent).
"""
from __future__ import annotations

import sys
import types

import pytest

from artifacta_mcp import openai_agents

# The default launch invokes the server via the current interpreter
# (PATH-independent), so default-mode args carry this prefix.
_MODULE_PREFIX = ["-m", "artifacta_mcp.cli"]

# --------------------------------------------------------------------------
# Public API contract — build_stdio_params is re-exported from the package root
# (the integration docs/examples import it from `artifacta_mcp`, not the private
# `_integration_common` module). Lock that so a refactor can't silently break
# published user code.
# --------------------------------------------------------------------------

def test_build_stdio_params_is_public_package_export():
    import artifacta_mcp

    assert hasattr(artifacta_mcp, "build_stdio_params")
    assert hasattr(artifacta_mcp, "ARTIFACTA_MCP_COMMAND")
    # Same object the wrapper modules use internally.
    assert artifacta_mcp.build_stdio_params is openai_agents.build_stdio_params


# --------------------------------------------------------------------------
# build_stdio_params — pure, no SDK
# --------------------------------------------------------------------------

def test_build_params_uses_explicit_key_and_default_command():
    params = openai_agents.build_stdio_params(api_key="ak_live_explicit")
    # Default launch is PATH-independent: current interpreter + `-m artifacta_mcp.cli`.
    assert params["command"] == sys.executable
    assert params["args"] == _MODULE_PREFIX
    assert params["env"]["ARTIFACTA_API_KEY"] == "ak_live_explicit"


def test_build_params_falls_back_to_env_key(monkeypatch):
    monkeypatch.setenv("ARTIFACTA_API_KEY", "ak_live_fromenv")
    params = openai_agents.build_stdio_params()
    assert params["env"]["ARTIFACTA_API_KEY"] == "ak_live_fromenv"


def test_build_params_explicit_key_overrides_env(monkeypatch):
    monkeypatch.setenv("ARTIFACTA_API_KEY", "ak_live_fromenv")
    params = openai_agents.build_stdio_params(api_key="ak_live_explicit")
    assert params["env"]["ARTIFACTA_API_KEY"] == "ak_live_explicit"


def test_build_params_missing_key_raises(monkeypatch):
    monkeypatch.delenv("ARTIFACTA_API_KEY", raising=False)
    with pytest.raises(ValueError, match="No Artifacta API key"):
        openai_agents.build_stdio_params()


def test_build_params_forwards_path(monkeypatch):
    monkeypatch.setenv("PATH", "/custom/bin:/usr/bin")
    params = openai_agents.build_stdio_params(api_key="ak_live_x")
    # PATH crosses over (the mcp stdio client uses env verbatim, no os.environ
    # merge) so pipx / custom commands still resolve in the child.
    assert params["env"]["PATH"] == "/custom/bin:/usr/bin"


def test_build_params_api_url_overlaid_when_given():
    params = openai_agents.build_stdio_params(
        api_key="ak_live_x", api_url="https://staging.artifacta.io"
    )
    assert params["env"]["ARTIFACTA_API_URL"] == "https://staging.artifacta.io"


def test_build_params_api_url_from_env(monkeypatch):
    monkeypatch.setenv("ARTIFACTA_API_URL", "https://env.artifacta.io")
    params = openai_agents.build_stdio_params(api_key="ak_live_x")
    assert params["env"]["ARTIFACTA_API_URL"] == "https://env.artifacta.io"


def test_build_params_no_api_url_means_no_override(monkeypatch):
    monkeypatch.delenv("ARTIFACTA_API_URL", raising=False)
    params = openai_agents.build_stdio_params(api_key="ak_live_x")
    assert "ARTIFACTA_API_URL" not in params["env"]


def test_build_params_single_allow_path():
    params = openai_agents.build_stdio_params(api_key="ak_live_x", allow_path="/abs/dir")
    assert params["args"] == _MODULE_PREFIX + ["--allow-path", "/abs/dir"]


def test_build_params_multiple_allow_paths():
    params = openai_agents.build_stdio_params(
        api_key="ak_live_x", allow_path=["/a", "/b"]
    )
    assert params["args"] == _MODULE_PREFIX + [
        "--allow-path", "/a", "--allow-path", "/b",
    ]


def test_build_params_allow_destructive_flag():
    params = openai_agents.build_stdio_params(
        api_key="ak_live_x", allow_path="/a", allow_destructive=True
    )
    assert params["args"] == _MODULE_PREFIX + [
        "--allow-path", "/a", "--allow-destructive",
    ]


def test_build_params_no_destructive_by_default():
    params = openai_agents.build_stdio_params(api_key="ak_live_x")
    assert "--allow-destructive" not in params["args"]


# --------------------------------------------------------------------------
# Default launch command — PATH-independent (notebooks / IDE kernels)
# --------------------------------------------------------------------------

def test_build_params_default_uses_current_interpreter():
    params = openai_agents.build_stdio_params(api_key="ak_live_x")
    # `sys.executable -m artifacta_mcp.cli` works even when the artifacta-mcp
    # console script is not on PATH (the bug Codex flagged).
    assert params["command"] == sys.executable
    assert params["args"][:2] == ["-m", "artifacta_mcp.cli"]


def test_build_params_default_module_args_precede_flags():
    params = openai_agents.build_stdio_params(
        api_key="ak_live_x", allow_path="/a", allow_destructive=True
    )
    assert params["args"] == [
        "-m", "artifacta_mcp.cli", "--allow-path", "/a", "--allow-destructive",
    ]


def test_build_params_explicit_command_skips_module_prefix(tmp_path):
    # An explicit absolute command supplies its own args; no `-m` prefix.
    fake = tmp_path / "artifacta-mcp"
    fake.write_text("#!/bin/sh\n")
    params = openai_agents.build_stdio_params(
        api_key="ak_live_x", command=str(fake), allow_destructive=True
    )
    assert params["command"] == str(fake)
    assert params["args"] == ["--allow-destructive"]


def test_build_params_bare_command_not_on_path_raises():
    with pytest.raises(ValueError, match="not found on PATH"):
        openai_agents.build_stdio_params(
            api_key="ak_live_x", command="definitely-not-a-real-command-xyz"
        )


def test_build_params_console_script_command_respected(monkeypatch):
    # Opting into the console script by name works when it resolves on PATH.
    import artifacta_mcp

    monkeypatch.setattr(
        "artifacta_mcp._integration_common.shutil.which", lambda _c: "/usr/bin/artifacta-mcp"
    )
    params = openai_agents.build_stdio_params(
        api_key="ak_live_x", command=artifacta_mcp.ARTIFACTA_MCP_COMMAND
    )
    assert params["command"] == "artifacta-mcp"
    assert params["args"] == []  # no `-m` prefix for an explicit command


def test_build_params_custom_command_and_args_prefix(monkeypatch):
    # pipx may not be installed on the test machine; the bare-name PATH check is
    # exercised separately, so stub it here to focus on arg ordering.
    monkeypatch.setattr(
        "artifacta_mcp._integration_common.shutil.which", lambda _c: "/usr/bin/pipx"
    )
    params = openai_agents.build_stdio_params(
        api_key="ak_live_x",
        command="pipx",
        args=["run", "artifacta-mcp"],
        allow_destructive=True,
    )
    assert params["command"] == "pipx"
    # Explicit command → no `-m` prefix; user args lead, flags follow.
    assert params["args"] == ["run", "artifacta-mcp", "--allow-destructive"]


def test_build_params_extra_env_overlaid():
    params = openai_agents.build_stdio_params(
        api_key="ak_live_x", extra_env={"ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM": "1"}
    )
    assert params["env"]["ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM"] == "1"


# --------------------------------------------------------------------------
# Env sanitization — the child gets a minimal env, NOT the full parent
# environment (Codex high finding: secret + allow-list leakage).
# --------------------------------------------------------------------------

def test_build_params_does_not_leak_unrelated_parent_secrets(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-not-leak")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "aws-should-not-leak")
    monkeypatch.setenv("SOME_RANDOM_TOKEN", "nope")
    params = openai_agents.build_stdio_params(api_key="ak_live_x")
    env = params["env"]
    assert "OPENAI_API_KEY" not in env
    assert "AWS_SECRET_ACCESS_KEY" not in env
    assert "SOME_RANDOM_TOKEN" not in env
    # The Artifacta key still crosses over.
    assert env["ARTIFACTA_API_KEY"] == "ak_live_x"


def test_build_params_does_not_inherit_ambient_allow_path(monkeypatch):
    # Ambient ARTIFACTA_MCP_ALLOW_PATH must NOT widen the child's allow-list —
    # the allow-list comes only from allow_path= / --allow-path args.
    monkeypatch.setenv("ARTIFACTA_MCP_ALLOW_PATH", "/etc:/root")
    params = openai_agents.build_stdio_params(api_key="ak_live_x", allow_path="/abs/out")
    assert "ARTIFACTA_MCP_ALLOW_PATH" not in params["env"]
    # The narrow allow_path still reaches the server via args only.
    assert params["args"] == ["-m", "artifacta_mcp.cli", "--allow-path", "/abs/out"]


def test_build_params_forwards_proxy_and_ca_vars(monkeypatch):
    # Proxy / custom-CA config IS forwarded — the server makes real HTTPS calls
    # and would break behind a proxy otherwise (these are infra config, not
    # app secrets). Regression guard: the old dict(os.environ) forwarded them.
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.corp:8080")
    monkeypatch.setenv("REQUESTS_CA_BUNDLE", "/etc/ssl/corp-ca.pem")
    params = openai_agents.build_stdio_params(api_key="ak_live_x")
    assert params["env"]["HTTPS_PROXY"] == "http://proxy.corp:8080"
    assert params["env"]["REQUESTS_CA_BUNDLE"] == "/etc/ssl/corp-ca.pem"


def test_build_params_does_not_inherit_ambient_write_confirm(monkeypatch):
    # Other ambient MCP knobs are likewise not silently forwarded — pass them
    # deliberately via extra_env if wanted.
    monkeypatch.setenv("ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM", "1")
    params = openai_agents.build_stdio_params(api_key="ak_live_x")
    assert "ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM" not in params["env"]


def test_build_params_extra_env_cannot_override_api_key():
    with pytest.raises(ValueError, match="ARTIFACTA_API_KEY"):
        openai_agents.build_stdio_params(
            api_key="ak_live_x", extra_env={"ARTIFACTA_API_KEY": "ak_live_sneaky"}
        )


def test_build_params_extra_env_cannot_override_api_url():
    with pytest.raises(ValueError, match="ARTIFACTA_API_URL"):
        openai_agents.build_stdio_params(
            api_key="ak_live_x", extra_env={"ARTIFACTA_API_URL": "https://evil.example"}
        )


# --------------------------------------------------------------------------
# artifacta_mcp_server / register — gated on the optional SDK
# --------------------------------------------------------------------------

class _FakeMCPServerStdio:
    """Stand-in for agents.mcp.MCPServerStdio — records constructor kwargs."""

    def __init__(self, *, params, cache_tools_list, name, **extra):
        self.params = params
        self.cache_tools_list = cache_tools_list
        self.name = name
        self.extra = extra


@pytest.fixture
def fake_agents_sdk(monkeypatch):
    """Inject a fake `agents.mcp` module exposing MCPServerStdio."""
    agents_pkg = types.ModuleType("agents")
    agents_mcp = types.ModuleType("agents.mcp")
    agents_mcp.MCPServerStdio = _FakeMCPServerStdio
    agents_pkg.mcp = agents_mcp
    monkeypatch.setitem(sys.modules, "agents", agents_pkg)
    monkeypatch.setitem(sys.modules, "agents.mcp", agents_mcp)
    return agents_mcp


def test_artifacta_mcp_server_builds_with_fake_sdk(fake_agents_sdk):
    server = openai_agents.artifacta_mcp_server(
        api_key="ak_live_x", allow_path="/abs", allow_destructive=True, name="art"
    )
    assert isinstance(server, _FakeMCPServerStdio)
    assert server.name == "art"
    assert server.cache_tools_list is True
    assert server.params["command"] == sys.executable
    assert server.params["args"] == [
        "-m", "artifacta_mcp.cli", "--allow-path", "/abs", "--allow-destructive",
    ]
    assert server.params["env"]["ARTIFACTA_API_KEY"] == "ak_live_x"


def test_artifacta_mcp_server_missing_sdk_raises_importerror(monkeypatch):
    # Ensure neither a real nor a fake agents module shadows the import.
    monkeypatch.setitem(sys.modules, "agents", None)
    monkeypatch.setitem(sys.modules, "agents.mcp", None)
    with pytest.raises(ImportError, match="openai-agents"):
        openai_agents.artifacta_mcp_server(api_key="ak_live_x")


class _FakeAgent:
    def __init__(self, mcp_servers=None):
        if mcp_servers is not None:
            self.mcp_servers = mcp_servers


def test_register_builds_and_appends_server(fake_agents_sdk):
    agent = _FakeAgent(mcp_servers=[])
    server = openai_agents.register(agent, api_key="ak_live_x")
    assert agent.mcp_servers == [server]
    assert isinstance(server, _FakeMCPServerStdio)


def test_register_preserves_existing_servers(fake_agents_sdk):
    sentinel = object()
    agent = _FakeAgent(mcp_servers=[sentinel])
    server = openai_agents.register(agent, api_key="ak_live_x")
    assert agent.mcp_servers == [sentinel, server]


def test_register_creates_list_when_absent(fake_agents_sdk):
    agent = _FakeAgent()  # no mcp_servers attribute at all
    server = openai_agents.register(agent, api_key="ak_live_x")
    assert agent.mcp_servers == [server]


def test_register_with_explicit_server_does_not_rebuild(fake_agents_sdk):
    agent = _FakeAgent(mcp_servers=[])
    existing_server = _FakeMCPServerStdio(params={}, cache_tools_list=True, name="x")
    returned = openai_agents.register(agent, server=existing_server)
    assert returned is existing_server
    assert agent.mcp_servers == [existing_server]


def test_register_rejects_server_and_kwargs_together(fake_agents_sdk):
    agent = _FakeAgent(mcp_servers=[])
    existing_server = _FakeMCPServerStdio(params={}, cache_tools_list=True, name="x")
    with pytest.raises(TypeError, match="not both"):
        openai_agents.register(agent, server=existing_server, api_key="ak_live_x")
