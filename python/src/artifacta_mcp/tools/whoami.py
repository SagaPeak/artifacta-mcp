"""whoami tool — plan §2.1."""
from __future__ import annotations

from typing import Any

from .. import whoami_cache
from ..safety import ToolRegistration, register_tool
from ._common import error_result, get_client, passthrough_result

WHOAMI_DESCRIPTION = (
    "Return the calling tenant's identity, plan tier, current usage counters "
    "(storage bytes, monthly requests, active links), and rate limits. Use this "
    "once at the start of an agent run to confirm authentication and to size "
    "subsequent operations against quota. Free of side effects and quota-cheap."
)

INPUT_SCHEMA = {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": False,
}


async def handler(_args: dict[str, Any] | None, _ctx) -> dict[str, Any]:
    client = get_client()
    try:
        info = client.whoami()
    except Exception as exc:
        return error_result(exc, "whoami")
    data = info.to_dict()
    suffix = data.get("api_key_last_4")
    if isinstance(suffix, str):
        whoami_cache.cache_key_suffix(suffix)
    return passthrough_result(data)


def register() -> None:
    register_tool(
        ToolRegistration(
            name="whoami",
            description=WHOAMI_DESCRIPTION,
            input_schema=INPUT_SCHEMA,
            safety="safe",
            handler=handler,
        )
    )
