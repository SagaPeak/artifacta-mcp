"""Cross-runtime transcript schema and write behavior fixture (Python side)."""
from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path

import pytest
from artifacta.transcript import apply_transcript_write_defaults

from artifacta_mcp.tools import list_artifacts, store_artifact

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "shared" / "transcript-v1-fixture.json").read_text(
        encoding="utf-8"
    )
)


class _Artifact:
    def to_dict(self):
        return {"artifact_id": "art_fixture"}


class _RecordingClient:
    def __init__(self):
        self.kwargs = None

    def push(self, **kwargs):
        self.kwargs = kwargs
        return _Artifact()


def _call(args, monkeypatch):
    client = _RecordingClient()
    monkeypatch.setattr(store_artifact, "get_client", lambda: client)
    result = asyncio.run(store_artifact.handler(args, None))
    return result, client


def test_store_schema_property_matches_shared_fixture():
    assert store_artifact.INPUT_SCHEMA["properties"]["transcript"] == FIXTURE[
        "store_schema_property"
    ]


@pytest.mark.parametrize("case", FIXTURE["store_cases"], ids=lambda case: case["id"])
def test_store_behavior_matches_shared_fixture(case, monkeypatch):
    fixture_input = case["input"]
    original_metadata = fixture_input.get("metadata")
    args = {
        "filename": "session.jsonl",
        "content": base64.b64encode(b'{"role":"user"}\n').decode(),
        **fixture_input,
    }
    result, client = _call(args, monkeypatch)
    assert not result.get("isError")
    assert client.kwargs is not None
    assert client.kwargs["transcript"] is fixture_input.get("transcript", False)

    content_type, metadata = apply_transcript_write_defaults(
        content_type=client.kwargs["content_type"],
        metadata=client.kwargs["metadata"],
        transcript=client.kwargs["transcript"],
    )
    assert {
        "content_type": content_type,
        "metadata": metadata or None,
    } == case["expected"]
    if original_metadata is not None:
        assert fixture_input["metadata"] is original_metadata


@pytest.mark.parametrize("value", FIXTURE["invalid_raw_values"])
def test_invalid_raw_values_are_rejected_before_client_acquisition(value, monkeypatch):
    def fail_get_client():
        raise AssertionError("client acquisition must not occur")

    monkeypatch.setattr(store_artifact, "get_client", fail_get_client)
    result = asyncio.run(
        store_artifact.handler(
            {
                "filename": "session.jsonl",
                "content": "e30=",
                "transcript": value,
            },
            None,
        )
    )
    assert result["isError"] is True
    assert result["_meta"]["code"] == "invalid_request"


def test_list_schema_property_matches_shared_fixture():
    assert list_artifacts.INPUT_SCHEMA["properties"]["transcript"] == FIXTURE[
        "list_schema_property"
    ]


@pytest.mark.parametrize("case", FIXTURE["list_cases"], ids=lambda case: case["id"])
def test_list_behavior_matches_shared_fixture(case):
    fixture_input = case["input"]
    original_metadata = fixture_input.get("metadata")
    params = list_artifacts.build_params(fixture_input)
    normalized_metadata = {
        key.removeprefix("metadata."): value
        for key, value in params.items()
        if key.startswith("metadata.")
    }
    assert (normalized_metadata or None) == case["expected_metadata"]
    assert "transcript" not in params
    if original_metadata is not None:
        assert fixture_input["metadata"] is original_metadata


@pytest.mark.parametrize("value", FIXTURE["invalid_raw_values"])
def test_invalid_list_values_are_rejected_before_client_acquisition(value, monkeypatch):
    def fail_get_client():
        raise AssertionError("client acquisition must not occur")

    monkeypatch.setattr(list_artifacts, "get_client", fail_get_client)
    result = asyncio.run(list_artifacts.handler({"transcript": value}, None))
    assert result["isError"] is True
    assert result["_meta"]["code"] == "invalid_request"
