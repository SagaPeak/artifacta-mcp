"""Shared test fixtures/constants.

`HAS_TRANSCRIPT_CAPABILITY` / `TRANSCRIPT_CAPABILITY_SKIP_REASON` gate tests
that assert behavior against the **real, installed** `artifacta` SDK (as
opposed to stubs). The transcript sugar (`Client.push(transcript=...)`,
`artifacta.transcript`) was added to the CLI/SDK source tree by
AF_TRANSCRIPT-1.1..2.2 but has not yet been published in a new
`artifacta-cli` release on PyPI (latest published is 0.3.0, tagged
2026-06-05 — before the transcript work landed on 2026-07-15).

In the monorepo, `cli/` is installed editable and always has the capability.
In the public mirror (SagaPeak/artifacta-mcp), CI installs `artifacta-cli`
from PyPI, where the capability is absent until a new `cli-v*` tag is cut
and published. These tests skip (not fail, not silently pass) in that
situation, with a reason that names exactly what's missing and how to fix
it — this is capability-detection in the same spirit as
`artifacta_mcp.sdk_compat.check_sdk_compatibility`, not a blanket skip.
"""
from __future__ import annotations

import inspect

from artifacta import Client as _RealClient

HAS_TRANSCRIPT_CAPABILITY = "transcript" in inspect.signature(_RealClient.push).parameters

TRANSCRIPT_CAPABILITY_SKIP_REASON = (
    "installed artifacta-cli release predates the `transcript` capability "
    "(Client.push kwarg / artifacta.transcript module added by "
    "AF_TRANSCRIPT-1.1..2.2, not yet published to PyPI — publish a cli-v* "
    "tag newer than cli-v0.3.0 to restore this coverage)"
)
