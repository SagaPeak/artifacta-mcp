"""Build an HttpFailure from a non-SDK exception (network/transport surprise)."""
from __future__ import annotations

from ..errors import HttpErrorBody, HttpFailure


def network_failure(exc: Exception) -> HttpFailure:
    return HttpFailure(
        error=HttpErrorBody(
            code="network_error",
            message=str(exc) or type(exc).__name__,
            status=0,
        ),
        attempts=1,
    )
