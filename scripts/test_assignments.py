#!/usr/bin/env python3
"""Lesson 8 integration test: real HTTP -> Vinext -> D1 (Python 3.8+).

Run from your AudioLab project root:
    python3 -u scripts/test_assignments.py PROJECT_UUID DATASET_UUID [BASE_URL]

This test creates two demo members and two persisted assignments. It does NOT
reset the database or upload audio. It assumes Lesson 7's Task Instance API
already has at least one saved instance in the target project and dataset.

IMPORTANT: demo user IDs are NOT authenticated. This is local-only testing.
"""
import json
import sys
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def api(method, path, payload=None):
    """Return (status_code, decoded_body); show HTTP 405 even if body is empty."""
    raw = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(
        BASE + path,
        method=method,
        data=raw,
        headers={"Content-Type": "application/json"} if raw is not None else {},
    )
    try:
        response = urlopen(request, timeout=30)
    except HTTPError as error:
        response = error
    except URLError as error:
        raise RuntimeError("Cannot reach Vinext: {}".format(error)) from error

    with response:
        data = response.read()
        try:
            decoded = json.loads(data.decode("utf-8")) if data else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            decoded = {"nonJsonBody": data[:400].decode("utf-8", "replace")}
        return response.code, decoded


def expect(status, expected, body):
    if status != expected:
        raise RuntimeError("Expected HTTP {}, received {}: {}".format(expected, status, body))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("Usage: python3 scripts/test_assignments.py PROJECT_UUID DATASET_UUID [BASE_URL]")
    PROJECT, DATASET = sys.argv[1:3]
    BASE = (sys.argv[3] if len(sys.argv) > 3 else "http://localhost:5173").rstrip("/")

    # The 100 MMAU audio objects are NOT re-uploaded. An instance created in
    # Lesson 7 is all that's necessary to test assignments.
    qs = urlencode({"projectId": PROJECT, "datasetId": DATASET})
    status, body = api("GET", "/api/v1/task-instances?" + qs)
    expect(status, 200, body)
    instances = body["instances"]
    if not instances:
        sys.exit("No Task Instance found. Run Lesson 7's test_task_instances.py first.")
    instance_id = instances[0]["id"]
    print("[1/10] Found existing Task Instance:", instance_id, flush=True)

    # Generate unique demo IDs every run, so rerunning the test won't conflict
    # with old assignments or overwrite any teammates' records.
    token = uuid.uuid4().hex[:10]
    alice, bob = "dev-alice-" + token, "dev-bob-" + token
    for user_id, name in ((alice, "Test Alice"), (bob, "Test Bob")):
        status, body = api("POST", "/api/v1/project-members", {
            "projectId": PROJECT, "userId": user_id,
            "displayName": name, "role": "labeller",
        })
        expect(status, 201, body)
        assert body["member"]["role"] == "labeller"
    print("[2/10] Registered two real D1 project members", flush=True)

    status, body = api("GET", "/api/v1/project-members?" + urlencode({"projectId": PROJECT}))
    expect(status, 200, body)
    member_ids = {member["userId"] for member in body["members"]}
    assert {alice, bob} <= member_ids
    print("[3/10] Project member list contains both labellers", flush=True)

    created = {}
    for labeller in (alice, bob):
        status, body = api("POST", "/api/v1/assignments", {
            "projectId": PROJECT,
            "taskInstanceId": instance_id,
            "labellerId": labeller,
        })
        expect(status, 201, body)
        assignment = body["assignment"]
        assert assignment["status"] == "assigned"
        created[labeller] = assignment["id"]
    assert created[alice] != created[bob]
    print("[4/10] Assigned the SAME task to TWO independent labellers", flush=True)

    status, body = api("POST", "/api/v1/assignments", {
        "projectId": PROJECT,
        "taskInstanceId": instance_id,
        "labellerId": alice,
    })
    expect(status, 409, body)
    print("[5/10] Duplicate assignment correctly rejected (409)", flush=True)

    status, body = api("GET", "/api/v1/labeller/queue?" + urlencode({
        "projectId": PROJECT, "labellerId": alice,
    }))
    expect(status, 200, body)
    alice_ids = {row["id"] for row in body["assignments"]}
    assert created[alice] in alice_ids and created[bob] not in alice_ids
    print("[6/10] Labeller queue contains Alice's task, not Bob's", flush=True)

    status, body = api("GET", "/api/v1/assignments/" + created[alice])
    expect(status, 200, body)
    preview = body["taskInstance"]
    assert preview["id"] == instance_id
    assert preview["audioUrl"].startswith("/api/v1/assets/")
    # This tests for accidental reference-label fields, not for text that
    # legitimately occurs in the source multiple-choice options.
    forbidden = ("source_labels", "referenceAnswer", "reference_answer", "earlyAnnotation")
    assert not any(term in json.dumps(body) for term in forbidden)
    print("[7/10] Detail returns audio + published blocks; no reference answers", flush=True)

    status, body = api("POST", "/api/v1/assignments/{}/start".format(created[alice]), {
        "labellerId": alice,
    })
    expect(status, 200, body)
    assert body["assignment"]["status"] == "in_progress"
    assert body["assignment"]["startedAt"] is not None
    print("[8/10] Started Alice's assignment: assigned -> in_progress", flush=True)

    status, body = api("POST", "/api/v1/assignments/{}/start".format(created[alice]), {
        "labellerId": alice,
    })
    expect(status, 409, body)
    status, body = api("POST", "/api/v1/assignments/{}/start".format(created[bob]), {
        "labellerId": alice,
    })
    expect(status, 409, body)
    print("[9/10] Repeat start and wrong-labeller start rejected (409)", flush=True)

    status, body = api("GET", "/api/v1/assignments?" + urlencode({"projectId": PROJECT}))
    expect(status, 200, body)
    ids = {row["id"] for row in body["assignments"]}
    assert set(created.values()) <= ids
    print("[10/10] Admin project list includes both assignments", flush=True)
    print("\nPASS: Assignments and Labeller Queue end-to-end.", flush=True)
    print("Demo IDs:", alice, bob, flush=True)
