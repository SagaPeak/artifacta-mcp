"""Autonomy-boundary engine (AF_MCP-1.5 port).

Single module covering what the TS server splits across `safety/{registry,
flags,audit}.ts`:

- `ToolRegistration` describes a tool's name + JSON Schema + safety class +
  always-confirm flag + the async handler.
- `register_tool` + `clear_registry` manage a module-level registry.
- `get_filtered_tools` is the `tools/list` filter — destructive tools are
  absent for non-compliant clients unless `--allow-destructive` was passed;
  for compliant clients, destructive + always-confirm + write-tools-under-
  env-flag get `_meta.requiresConfirmation = True`.
- `is_call_permitted` is the call-time gate — must be checked in the
  CallTool handler in addition to `tools/list` filtering.
- `parse_safety_flags` reads `--allow-destructive` from argv ONLY (never from
  env — security design per plan §5 Notes) and
  `ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM` from env.
- `emit_destructive_audit` writes the `[artifacta-mcp] destructive call: …`
  stderr line with secret redaction + 200-char truncation.
"""
from __future__ import annotations

import json
import os
import re
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

ToolSafety = Literal["safe", "writeIdempotent", "writeNonIdempotent", "destructive"]


@dataclass
class ToolCallContext:
    """Per-call context threaded into tool handlers (AF_MCP-1.7)."""

    request_id: str
    # The connected MCP client's `clientInfo.name` from the `initialize`
    # handshake (e.g. "claude-code"), when the session exposes it. None when
    # unavailable. Used by store_artifact (AF_MCP-PROV) to auto-stamp
    # `agent_id` when the caller didn't supply one.
    client_name: str | None = None


ToolHandler = Callable[[dict[str, Any] | None, ToolCallContext], Awaitable[dict[str, Any]]]


@dataclass
class ToolRegistration:
    name: str
    description: str
    input_schema: dict[str, Any]
    safety: ToolSafety
    handler: ToolHandler
    always_confirm: bool = False
    meta: dict[str, Any] = field(default_factory=dict)


# Tools that get `_meta.requiresConfirmation = True` when
# ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM=1, for compliant clients only.
WRITE_CONFIRM_TOOL_NAMES: set[str] = {
    "store_artifact",
    "request_upload_url",
    "complete_upload",
    "create_download_link",
}


_registry: dict[str, ToolRegistration] = {}


def tool_annotations(name: str, safety: ToolSafety) -> dict[str, bool]:
    """MCP ToolAnnotations per AF_MCP-1.5 / AF_MCP-REG-2 safety table."""
    if safety == "safe":
        return {"readOnlyHint": True}
    if safety == "destructive":
        return {"destructiveHint": True}
    annotations: dict[str, bool] = {"readOnlyHint": False}
    if name == "store_artifact":
        annotations["idempotentHint"] = True
    return annotations


def register_tool(reg: ToolRegistration) -> None:
    _registry[reg.name] = reg


def get_tool_registration(name: str) -> ToolRegistration | None:
    return _registry.get(name)


def clear_registry() -> None:
    _registry.clear()


def all_registrations() -> list[ToolRegistration]:
    return list(_registry.values())


@dataclass
class FilterOpts:
    has_confirmations: bool
    allow_destructive: bool
    write_confirm_required: bool


def get_filtered_tools(opts: FilterOpts) -> list[dict[str, Any]]:
    """Build the public `tools/list` response with gating + confirmation flags.

    Returns a list of `{name, description, inputSchema, _meta}` dicts ready to
    serialize as the MCP `tools/list` payload.
    """
    result: list[dict[str, Any]] = []
    for reg in _registry.values():
        # Non-compliant client: destructive tools are absent unless --allow-destructive
        if reg.safety == "destructive" and not opts.has_confirmations and not opts.allow_destructive:
            continue

        requires_confirmation = False
        if opts.has_confirmations:
            if reg.safety == "destructive":
                requires_confirmation = True
            if reg.always_confirm:
                requires_confirmation = True
            if opts.write_confirm_required and reg.name in WRITE_CONFIRM_TOOL_NAMES:
                requires_confirmation = True

        tool: dict[str, Any] = {
            "name": reg.name,
            "description": reg.description,
            "inputSchema": reg.input_schema,
            "annotations": tool_annotations(reg.name, reg.safety),
        }
        meta = dict(reg.meta)
        if requires_confirmation:
            meta["requiresConfirmation"] = True
        if meta:
            tool["_meta"] = meta
        result.append(tool)
    return result


def is_call_permitted(
    reg: ToolRegistration,
    has_confirmations: bool,
    allow_destructive: bool,
) -> bool:
    """Server-side call-time gate — mirrors the `tools/list` filter.

    Returns False when the tool must be blocked at dispatch (non-compliant
    client without --allow-destructive calling a destructive tool directly).
    """
    if reg.safety == "destructive" and not has_confirmations and not allow_destructive:
        return False
    return True


# ---------------------------------------------------------------------------
# Flags (TS safety/flags.ts)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SafetyFlags:
    allow_destructive: bool
    write_confirm_required: bool


def parse_safety_flags(argv: list[str]) -> SafetyFlags:
    return SafetyFlags(
        # CLI argv ONLY — never from env or config file (security design, §5 Notes)
        allow_destructive="--allow-destructive" in argv,
        write_confirm_required=os.environ.get("ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM") == "1",
    )


# ---------------------------------------------------------------------------
# Audit emitter (TS safety/audit.ts)
# ---------------------------------------------------------------------------


_SECRET_PATTERN = re.compile(
    r"""(["']?(?:api[_-]?key|password|secret|token|auth)["']?\s*[:=]\s*["']?)([^\s"',}\]]{4,})""",
    re.IGNORECASE,
)


def _redact_secrets(s: str) -> str:
    return _SECRET_PATTERN.sub(r"\1[REDACTED]", s)


def emit_destructive_audit(tool_name: str, args: Any) -> None:
    try:
        args_str = json.dumps(args, default=str)
    except (TypeError, ValueError):
        args_str = str(args)
    args_str = _redact_secrets(args_str)
    if len(args_str) > 200:
        args_str = args_str[:200] + "..."
    sys.stderr.write(
        f"[artifacta-mcp] destructive call: {tool_name}({args_str}) — no confirmation surface\n"
    )
