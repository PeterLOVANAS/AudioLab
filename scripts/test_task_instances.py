#!/usr/bin/env python3
"""Integration test for Lesson 7: real HTTP -> Vinext -> D1.

Usage (from AudioLab project root, Python 3.8+):
  python3 -u scripts/test_task_instances.py PROJECT_UUID DATASET_UUID [BASE_URL]

The test creates a real draft, publishes it, and inserts one new instance.
It does NOT delete existing data. Only use your private local development API.
"""
import json
import sys
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def api(method, path, body=None):
    """Return (HTTP code, JSON value); avoid hiding 405 errors behind JSONDecodeError."""
    payload = json.dumps(body).encode("utf-8") if body is not None else None
    request = Request(
        BASE + path,
        data=payload,
        method=method,
        headers={"Content-Type": "application/json"} if payload is not None else {},
    )
    try:
        response = urlopen(request, timeout=30)
    except HTTPError as error:
        response = error  # 400, 404 and 409 are valid test outcomes.
    with response:
        data = response.read()
        try:
            decoded = json.loads(data) if data else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            decoded = {"nonJsonBody": data[:300].decode("utf-8", errors="replace")}
        return response.code, decoded


def expect(code, expected, body):
    if code != expected:
        raise RuntimeError("Expected HTTP {}, got {}: {}".format(expected, code, body))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("Usage: python3 scripts/test_task_instances.py PROJECT_UUID DATASET_UUID [BASE_URL]")
    PROJECT, DATASET = sys.argv[1:3]
    BASE = (sys.argv[3] if len(sys.argv) >= 4 else "http://localhost:5173").rstrip("/")

    # 1. Use the real assets you've already imported (not a fake WAV).
    status, body = api("GET", "/api/v1/assets?datasetId=" + DATASET)
    expect(status, 200, body)
    assets = body["assets"]
    if not assets:
        sys.exit("Dataset has no audio assets. Verify the MMAU import first.")
    asset_id = assets[0]["id"]
    print("[1/9] Found existing MMAU audio", asset_id, flush=True)

    # 2. Create a new protocol in the same project as the dataset.
    draft = {
        "name": "Lesson 7 task instance test " + uuid.uuid4().hex[:8],
        "description": "Integration test; no real labeller assignment.",
        "domain": "sound",
        "instructions": "Listen and classify whether a voice is audible.",
        "blocks": [{
            "id": "audible", "type": "single_choice", "label": "Voice audible?",
            "required": True, "options": [
                {"id": "yes", "label": "Yes"},
                {"id": "no", "label": "No"},
            ],
        }],
        "policy": {"requiredIndependentVotes": 2, "blindToOthers": True,
                   "requiresReview": True},
        "workspace": {"waveform": True},
    }
    status, body = api("POST", "/api/v1/task-definitions", {"projectId": PROJECT, "draft": draft})
    expect(status, 201, body)
    definition_id = body["taskDefinition"]["id"]
    print("[2/9] Created task definition", definition_id, flush=True)

    # 3. Publish protocol version 1. A mutable DRAFT cannot be instantiated.
    status, body = api("POST", "/api/v1/task-definitions/{}/publish".format(definition_id),
                       {"expectedRevision": 1, "expectedPublishedVersion": 0})
    expect(status, 201, body)
    print("[3/9] Published immutable version 1", flush=True)

    payload = {
        "projectId": PROJECT,
        "definitionId": definition_id,
        "definitionVersion": 1,
        "assetId": asset_id,
    }
    # 4. Create one real Task Instance pointing to MMAU + published definition.
    status, body = api("POST", "/api/v1/task-instances", payload)
    expect(status, 201, body)
    task_id = body["taskInstance"]["id"]
    print("[4/9] Created task instance", task_id, flush=True)

    # 5. Creating the same definition+version+audio again must NOT duplicate.
    status, body = api("POST", "/api/v1/task-instances", payload)
    expect(status, 409, body)
    print("[5/9] Duplicate gives HTTP 409", flush=True)

    # 6. Admin project-scoped list includes our new instance.
    status, body = api("GET", "/api/v1/task-instances?projectId=" + PROJECT)
    expect(status, 200, body)
    assert any(item["id"] == task_id for item in body["instances"])
    print("[6/9] Listed the saved task", flush=True)

    # 7. Preview includes the original published definition and playback URL.
    status, body = api("GET", "/api/v1/task-instances/" + task_id)
    expect(status, 200, body)
    preview = body["taskInstance"]
    assert preview["definition"]["instructions"] == draft["instructions"]
    assert preview["audioUrl"] == "/api/v1/assets/{}/audio".format(asset_id)
    assert preview["sourceRecord"] is None
    assert "source_labels" not in json.dumps(preview).lower()
    assert "referenceAnswer" not in json.dumps(preview)
    print("[7/9] Preview has audio URL, published blocks, no source labels", flush=True)

    # 8. A version that has never been published must be rejected.
    bad_version = dict(payload, definitionVersion=999)
    status, body = api("POST", "/api/v1/task-instances", bad_version)
    expect(status, 404, body)
    print("[8/9] Unpublished version rejected (404)", flush=True)

    # 9. Optional: link one imported QA question, never its hidden answer.
    status, body = api("GET", "/api/v1/source-records?assetId=" + asset_id)
    expect(status, 200, body)
    records = body["sourceRecords"]
    if records:
        source_id = records[0]["sourceRecordId"]
        status, result = api("POST", "/api/v1/task-instances",
                             dict(payload, sourceRecordId=source_id))
        expect(status, 201, result)
        second = result["taskInstance"]
        assert second["sourceRecord"]["sourceRecordId"] == source_id
        assert "referenceAnswer" not in json.dumps(second)
        print("[9/9] Linked QA question without exposing reference answer", flush=True)
    else:
        print("[9/9] No source question for this asset; optional QA check skipped", flush=True)

    print("\nPASS: Task Instances API end-to-end. Definition ID={}, Task ID={}".format(
        definition_id, task_id), flush=True)
