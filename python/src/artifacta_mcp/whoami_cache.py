"""Caches the last 4 characters of the active API key from a successful whoami call.

The auth-failure remediation template includes "Last-known key suffix: ****<last4>"
so the agent can disambiguate which key it had configured when the call failed.
Populated by the whoami tool; read by errors.translate_http_failure.
"""
from __future__ import annotations

_cached_key_suffix: str | None = None


def cache_key_suffix(last4: str) -> None:
    global _cached_key_suffix
    _cached_key_suffix = last4


def get_cached_key_suffix() -> str | None:
    return _cached_key_suffix


def clear_key_suffix_cache() -> None:
    global _cached_key_suffix
    _cached_key_suffix = None
