#!/usr/bin/env python3
"""Lesson 9: real HTTP integration test (Python 3.8+, no pip dependencies).

Usage:
  python3 -u scripts/test_annotations.py PROJECT_UUID DATASET_UUID [BASE_URL]

Creates one NEW Task Definition, Task Instance, two dev Labellers, and two
assignments in your actual local D1. Does not modify the existing MMAU audio
or import new files. Run only after migration 0007 is applied and Vinext runs.

All requests exercise real Vinext routes. No mocked responses.
"""
import json
import sys
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def api(method, path, payload=None):
    """Return status plus body, even if the server sends empty/HTML errors."""
    raw = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = Request(BASE + path, data=raw, method=method,
                  headers={"Content-Type": "application/json"} if raw else {})
    try:
        resp = urlopen(req, timeout=30)
    except HTTPError as exc:
        resp = exc
    except URLError as exc:
        raise RuntimeError("Cannot reach Vinext: {}".format(exc)) from exc
    with resp:
        contents = resp.read()
        if not contents:
            data = None
        else:
            try:
                data = json.loads(contents.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                data = {"nonJsonBody": contents[:400].decode("utf-8", "replace")}
        return resp.code, data


def check(expected, result):
    code, body = result
    if code != expected:
        raise AssertionError("Expected HTTP {}, got {}: {}".format(expected, code, body))
    return body


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("Usage: python3 scripts/test_annotations.py PROJECT_UUID DATASET_UUID [BASE_URL]")
    PROJECT, DATASET = sys.argv[1:3]
    BASE = (sys.argv[3] if len(sys.argv) > 3 else "http://localhost:5173").rstrip("/")

    # Use one REAL existing MMAU audio asset from Lessons 4/5. This test does
    # not download/upload the WAV; it only connects it to a published protocol.
    assets = check(200, api("GET", "/api/v1/assets?" + urlencode({"datasetId": DATASET})))
    if not assets["assets"]:
        sys.exit("Dataset has no audio assets. Verify the MMAU import first.")
    asset_id = assets["assets"][0]["id"]
    print("[1/13] Existing MMAU audio asset:", asset_id, flush=True)

    # A new definition is created on every run to avoid collisions. This
    # intentionally tests a single-choice block, optional text, and boolean.
    suffix = uuid.uuid4().hex[:8]
    draft = {
        "name": "Lesson 9 Annotation QA " + suffix,
        "description": "Integration test of immutable human annotation revisions",
        "domain": "sound",
        "instructions": "Listen and label the recording without reading reference answers.",
        "blocks": [
            {"id": "voice", "type": "single_choice", "label": "Voice type?", "required": True,
             "options": [{"id": "man", "label": "Man"},
                         {"id": "woman", "label": "Woman"}]},
            {"id": "audible", "type": "boolean", "label": "Audible speech?", "required": True},
            {"id": "notes", "type": "text", "label": "Comments", "required": False},
        ],
        "policy": {"requiredIndependentVotes": 2, "blindToOthers": True, "requiresReview": True},
        "workspace": {"waveform": True},
    }
    created = check(201, api("POST", "/api/v1/task-definitions", {
        "projectId": PROJECT, "draft": draft,
    }))["taskDefinition"]
    definition_id = created["id"]
    published = check(201, api("POST", "/api/v1/task-definitions/{}/publish".format(definition_id), {
        "expectedRevision": created["draftRevision"],
        "expectedPublishedVersion": created["publishedVersion"],
    }))
    assert published["published"]["version"] == 1
    print("[2/13] Created + published a three-block task definition", flush=True)

    instance = check(201, api("POST", "/api/v1/task-instances", {
        "projectId": PROJECT, "definitionId": definition_id,
        "definitionVersion": 1, "assetId": asset_id,
    }))["taskInstance"]
    instance_id = instance["id"]
    alice, bob = "l9-alice-" + suffix, "l9-bob-" + suffix
    for person in (alice, bob):
        check(201, api("POST", "/api/v1/project-members", {
            "projectId": PROJECT, "userId": person,
            "displayName": person, "role": "labeller",
        }))
    a_id = check(201, api("POST", "/api/v1/assignments", {
        "projectId": PROJECT, "taskInstanceId": instance_id, "labellerId": alice,
    }))["assignment"]["id"]
    b_id = check(201, api("POST", "/api/v1/assignments", {
        "projectId": PROJECT, "taskInstanceId": instance_id, "labellerId": bob,
    }))["assignment"]["id"]
    print("[3/13] Created same task for two distinct Labellers", flush=True)

    base = "/api/v1/assignments/{}/annotation".format(a_id)
    get_current = lambda: api("GET", base + "?" + urlencode({"labellerId": alice}))
    current = check(200, get_current())
    assert current["current"] is None
    print("[4/13] New assignment has no annotation (revision 0)", flush=True)

    # A draft can be empty. This is useful for autosave or intermittent work.
    draft1 = check(201, api("POST", base + "/draft", {
        "labellerId": alice, "expectedRevision": 0, "answers": {},
    }))["annotation"]
    assert draft1["revision"] == 1 and draft1["status"] == "draft"
    status = check(200, api("GET", "/api/v1/assignments/" + a_id))
    assert status["assignment"]["status"] == "in_progress"
    print("[5/13] Saved partial draft v1; assignment became in_progress", flush=True)

    # Submissions require every visible required block.
    failed = check(422, api("POST", base + "/submit", {
        "labellerId": alice, "expectedRevision": 1, "answers": {},
    }))
    assert failed["issues"]
    print("[6/13] Incomplete submission rejected (422)", flush=True)

    # Invalid option IDs are rejected even for drafts.
    check(422, api("POST", base + "/draft", {
        "labellerId": alice, "expectedRevision": 1,
        "answers": {"voice": "unlisted-option"},
    }))
    print("[7/13] Invalid choice answer rejected (422)", flush=True)

    draft2 = check(201, api("POST", base + "/draft", {
        "labellerId": alice, "expectedRevision": 1,
        "answers": {"voice": "man", "notes": "Need to double-check", "audible": False},
    }))["annotation"]
    assert draft2["revision"] == 2 and draft2["answers"]["audible"] is False
    print("[8/13] Saved edited draft v2, preserving boolean false", flush=True)

    check(409, api("POST", base + "/draft", {
        "labellerId": alice, "expectedRevision": 1,
        "answers": {"voice": "woman", "audible": True},
    }))
    print("[9/13] Outdated revision rejected (409)", flush=True)

    # A final submission is immutable and automatically moves assignment state.
    final = check(201, api("POST", base + "/submit", {
        "labellerId": alice, "expectedRevision": 2,
        "answers": {"voice": "man", "audible": False, "notes": "Checked"},
    }))["annotation"]
    assert final["revision"] == 3 and final["status"] == "submitted"
    detail = check(200, api("GET", "/api/v1/assignments/" + a_id))
    assert detail["assignment"]["status"] == "submitted"
    print("[10/13] Submitted v3; assignment atomically marked submitted", flush=True)

    got = check(200, get_current())["current"]
    assert got["revision"] == 3 and got["answers"]["voice"] == "man"
    history = check(200, api("GET", base + "/revisions?" + urlencode({"labellerId": alice})))
    assert [r["revision"] for r in history["revisions"]] == [1, 2, 3]
    assert history["revisions"][0]["answers"] == {}
    print("[11/13] Current and immutable history return revisions 1, 2, 3", flush=True)

    check(409, api("POST", base + "/draft", {
        "labellerId": alice, "expectedRevision": 3, "answers": {},
    }))
    check(403, api("GET", base + "?" + urlencode({"labellerId": bob})))
    print("[12/13] Submitted task cannot be edited; other labeller denied", flush=True)

    queue_alice = check(200, api("GET", "/api/v1/labeller/queue?" + urlencode({
        "projectId": PROJECT, "labellerId": alice,
    })))
    queue_bob = check(200, api("GET", "/api/v1/labeller/queue?" + urlencode({
        "projectId": PROJECT, "labellerId": bob,
    })))
    assert a_id not in {row["id"] for row in queue_alice["assignments"]}
    assert b_id in {row["id"] for row in queue_bob["assignments"]}
    print("[13/13] Submitted task leaves Alice's queue; Bob's remains", flush=True)
    print("\nPASS: Annotation drafts, revisions, and submission end-to-end.", flush=True)
    print("Test assignment:", a_id, "| definition:", definition_id, flush=True)
