#!/usr/bin/env python3
"""AudioLab Task Definition API — REAL end-to-end integration test.

WHY THIS SCRIPT EXISTS:
    TypeScript can check whether code compiles, but cannot prove that our
    route/service/repository/migration work together against real local D1.
    This script makes actual HTTP requests to the running Vinext dev server.

TEST STORY:
    1. Create a definition draft.
    2. List definitions from D1 and confirm the new one appears.
    3. Publish version 1.
    4. Publish again using the old version counter -> 409.
    5. Edit the draft -> revision 2.
    6. Try another edit with old revision 1 -> 409.
    7. Publish version 2.
    8. Read versions 1 and 2, proving version 1 stayed unchanged.

RUN FROM THE AUDIOLAB PROJECT ROOT:
    python3 scripts/test_task_definitions.py PROJECT_UUID [BASE_URL]

This creates one real task definition; it does NOT clean up that test row.
Only run against your PRIVATE local development server. It is not a mock.
"""
import json
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def api(method, path, body=None):
    """Perform one actual HTTP request and return (status, parsed JSON).

    `method`: HTTP verb such as GET, POST, or PUT.
    `path`: route beginning with /api/v1/...
    `body`: optional Python dict; if given, encode it as JSON bytes.

    We intentionally catch HTTPError: urllib raises exceptions on 4xx/5xx,
    but 409 is an EXPECTED response in our concurrency safety tests.
    """
    url = base + path
    data = json.dumps(body).encode() if body is not None else None
    req = Request(
        url,
        method=method,
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    try:
        with urlopen(req, timeout=20) as response:
            return response.status, json.loads(response.read())
    except HTTPError as error:
        return error.code, json.loads(error.read())


def expect(status, expected, data):
    """Fail immediately with a useful message if an HTTP status is wrong."""
    if status != expected:
        raise RuntimeError(f"Expected HTTP {expected}, got {status}: {data}")


# Python runs this block only when this file is executed as a script.
# Importing `test_task_definitions` from another Python file does not run it.
if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Usage: python3 scripts/test_task_definitions.py PROJECT_UUID [BASE_URL]")

    project = sys.argv[1]
    base = (sys.argv[2] if len(sys.argv) > 2 else "http://localhost:5173").rstrip("/")

    # This is the annotation PROTOCOL, not a specific audio question/answer.
    # In JSON, Python's True becomes true, and dicts become JSON objects.
    draft = {
        "name": "AudioLab Task Definition API Integration Test",
        "description": "Testing editable drafts and immutable publication versions.",
        "domain": "sound",
        "instructions": "Listen and identify the voice type.",
        "blocks": [
            {
                "id": "voice",
                "type": "single_choice",
                "label": "Voice",
                "required": True,
                "options": [
                    {"id": "man", "label": "Man"},
                    {"id": "woman", "label": "Woman"},
                ],
            }
        ],
        "policy": {
            "requiredIndependentVotes": 2,
            "blindToOthers": True,
            "requiresReview": True,
        },
        "workspace": {"waveform": True},
    }

    # 1) CREATE: 201 means a new draft row exists in local D1.
    status, data = api(
        "POST", "/api/v1/task-definitions",
        {"projectId": project, "draft": draft},
    )
    expect(status, 201, data)
    task_id = data["taskDefinition"]["id"]
    print(f"[1/8] Created draft {task_id}, revision=1")

    # 2) LIST: ensure the GET list endpoint sees that saved row.
    status, data = api("GET", f"/api/v1/task-definitions?projectId={project}")
    expect(status, 200, data)
    assert any(x["id"] == task_id for x in data["definitions"])
    print("[2/8] Listed task definition")

    # 3) PUBLISH: freeze the current draft as version 1.
    status, data = api(
        "POST", f"/api/v1/task-definitions/{task_id}/publish",
        {"expectedRevision": 1, "expectedPublishedVersion": 0},
    )
    expect(status, 201, data)
    assert data["published"]["version"] == 1
    print("[3/8] Published immutable v1")

    # 4) CONFLICT: using publishedVersion=0 again must NOT create another v1.
    status, data = api(
        "POST", f"/api/v1/task-definitions/{task_id}/publish",
        {"expectedRevision": 1, "expectedPublishedVersion": 0},
    )
    expect(status, 409, data)
    print("[4/8] Repeating stale publish gives 409")

    # 5) EDIT: dict(..., instructions=...) makes a new Python dict, replacing
    # just the instructions for this request while retaining all other fields.
    edited = dict(draft, instructions="Updated instructions for v2.")
    status, data = api(
        "PUT", f"/api/v1/task-definitions/{task_id}",
        {"expectedRevision": 1, "draft": edited},
    )
    expect(status, 200, data)
    assert data["taskDefinition"]["draftRevision"] == 2
    print("[5/8] Updated draft to revision 2")

    # 6) CONFLICT: Friend B's stale revision=1 cannot overwrite revision=2.
    status, data = api(
        "PUT", f"/api/v1/task-definitions/{task_id}",
        {"expectedRevision": 1, "draft": edited},
    )
    expect(status, 409, data)
    print("[6/8] Stale draft update gives 409")

    # 7) PUBLISH v2: freeze the revised draft as a second snapshot.
    status, data = api(
        "POST", f"/api/v1/task-definitions/{task_id}/publish",
        {"expectedRevision": 2, "expectedPublishedVersion": 1},
    )
    expect(status, 201, data)
    assert data["published"]["version"] == 2
    print("[7/8] Published immutable v2")

    # 8) PROVE IMMUTABILITY: v1 has original instructions; v2 has new ones.
    status, data = api("GET", f"/api/v1/task-definitions/{task_id}/versions/1")
    expect(status, 200, data)
    assert data["published"]["definition"]["instructions"] == draft["instructions"]

    status, data = api("GET", f"/api/v1/task-definitions/{task_id}/versions/2")
    expect(status, 200, data)
    assert data["published"]["definition"]["instructions"] == edited["instructions"]

    print("[8/8] v1 unchanged while v2 contains updated instructions")
    print("PASS: Task Definition integration test")
