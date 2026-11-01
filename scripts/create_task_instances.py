#!/usr/bin/env python3
"""Optional local-dev importer: turn registered WAV assets into task instances.

This does NOT upload audio or create annotations. It calls the real backend.
Requires a definition that has ALREADY BEEN PUBLISHED in Lesson 6.

Usage:
  python3 -u scripts/create_task_instances.py PROJECT_UUID DATASET_UUID DEFINITION_UUID 1 \
    --mode audio --dry-run

  python3 -u scripts/create_task_instances.py PROJECT_UUID DATASET_UUID DEFINITION_UUID 1 \
    --mode qa

Modes:
  audio: create one instance per audio asset, ignoring original MMAU QA.
  qa: create an instance per imported source question; multiple per audio
      possible. Preview exposes question and choices but never source answers.

Duplicate request returns 409 and is safely skipped on rerun.
"""
import argparse
import json
import sys
from urllib.request import Request, urlopen
from urllib.error import HTTPError


def get_json(method, path, body=None):
    raw = json.dumps(body).encode("utf-8") if body is not None else None
    req = Request(base + path, data=raw, method=method,
                  headers={"Content-Type": "application/json"} if raw else {})
    try:
        resp = urlopen(req, timeout=40)
    except HTTPError as exc:
        resp = exc
    with resp:
        data = resp.read()
        try:
            payload = json.loads(data) if data else {}
        except (ValueError, UnicodeDecodeError):
            payload = {"bodyPreview": data[:300].decode("utf-8", "replace")}
        return resp.code, payload


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("project_id")
    ap.add_argument("dataset_id")
    ap.add_argument("definition_id")
    ap.add_argument("definition_version", type=int)
    ap.add_argument("--mode", choices=["audio", "qa"], default="audio")
    ap.add_argument("--base-url", default="http://localhost:5173")
    ap.add_argument("--limit", type=int, default=100,
                    help="Max number of AUDIO ASSETS selected (not questions)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if args.limit < 1 or args.limit > 200:
        ap.error("--limit must be between 1 and 200")
    base = args.base_url.rstrip("/")

    code, data = get_json("GET", "/api/v1/assets?datasetId=" + args.dataset_id)
    if code != 200:
        sys.exit("Cannot list assets: HTTP {} {}".format(code, data))
    assets = data["assets"][:args.limit]
    candidates = []
    for asset in assets:
        if args.mode == "audio":
            candidates.append((asset["id"], None))
        else:
            code, source = get_json("GET", "/api/v1/source-records?assetId=" + asset["id"])
            if code != 200:
                sys.exit("Cannot list source records: HTTP {} {}".format(code, source))
            for record in source["sourceRecords"]:
                # Source questions remain separate from Task Definition blocks.
                if record.get("question"):
                    candidates.append((asset["id"], record["sourceRecordId"]))

    print("Assets inspected: {}; tasks to attempt: {}; mode={}".format(
        len(assets), len(candidates), args.mode), flush=True)
    if args.dry_run:
        for asset, source in candidates[:5]:
            print("DRY RUN", asset, source, flush=True)
        sys.exit(0)

    created = conflicts = 0
    for index, (asset_id, source_id) in enumerate(candidates, start=1):
        payload = {
            "projectId": args.project_id,
            "definitionId": args.definition_id,
            "definitionVersion": args.definition_version,
            "assetId": asset_id,
        }
        if source_id is not None:
            payload["sourceRecordId"] = source_id
        code, body = get_json("POST", "/api/v1/task-instances", payload)
        if code == 201:
            created += 1
            print("[{}/{}] created {}".format(index, len(candidates), body["taskInstance"]["id"]), flush=True)
        elif code == 409 and "already has a task instance" in body.get("error", ""):
            conflicts += 1
            print("[{}/{}] existing (skipped)".format(index, len(candidates)), flush=True)
        else:
            sys.exit("Stopped on {}/{}: HTTP {} {}".format(index, len(candidates), code, body))
    print("DONE: created={}, already-existing={}".format(created, conflicts), flush=True)
