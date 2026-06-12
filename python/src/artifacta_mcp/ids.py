"""ID format regexes — must match `mcp/typescript/src/ids/formats.ts` exactly.

Pinned here for schema validation; the API enforces the same patterns server-side.
"""
from __future__ import annotations

ARTIFACT_ID_PATTERN = r"^art_[A-Za-z0-9]{16}$"
DOWNLOAD_LINK_ID_PATTERN = r"^lnk_[A-Za-z0-9]{20}$"
SESSION_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
