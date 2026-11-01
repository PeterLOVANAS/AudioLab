#!/usr/bin/env python3
"""Import a reproducible 60-sound / 40-speech local MMAU pilot into AudioLab.

Requires: pip install requests
Requires running local AudioLab backend with:
  POST /api/v1/assets
  GET  /api/v1/assets?datasetId=...
  POST /api/v1/source-records (only needed for qa/early/all modes)

Input: a JSON list (or JSONL) of MMAU records whose audio_id points to a
WAV file relative to --audio-root. No files are downloaded from Hugging Face.
"""
from __future__ import annotations

import argparse
import ast
import json
import random
import sys
from pathlib import Path
from typing import Any

import requests

MAX_BYTES = 10 * 1024 * 1024  # matches initial AudioLab upload endpoint


def load_rows(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".jsonl":
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    else:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            rows = data
        elif isinstance(data, dict) and isinstance(data.get("data"), list):
            rows = data["data"]
        else:
            raise ValueError("JSON must be a list of records (or an object with 'data' list).")
    if not all(isinstance(row, dict) for row in rows):
        raise ValueError("Every record must be a JSON object.")
    return rows



def audio_location(
    row: dict[str, Any],
    root: Path
) -> tuple[Path, str]:

    source = row.get("audio_id") or row.get("audio_path")

    if not isinstance(source, str) or not source:
        raise ValueError(
            f"Record {row.get('id')} has no audio path"
        )

    relative = Path(source)

    # First try the path exactly as supplied by MMAU.
    if relative.is_absolute():
        full_path = relative.resolve()
    else:
        full_path = (root / relative).resolve()

        # Some MMAU manifests use a different
        # directory prefix from the downloaded archive.
        #
        # Only try an exact filename in the known
        # test-mini-audios directory.
        if not full_path.is_file():
            alternative = (
                root / "test-mini-audios" / relative.name
            ).resolve()

            if alternative.is_file():
                full_path = alternative

    # Never allow files outside the configured root.
    try:
        original_path = full_path.relative_to(root).as_posix()
    except ValueError as exc:
        raise ValueError(
            f"Audio file is outside --audio-root: {source}"
        ) from exc

    return full_path, original_path



def parse_choices(value: Any) -> list[str] | None:
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            try:
                value = ast.literal_eval(value)
            except (SyntaxError, ValueError) as exc:
                raise ValueError("choices string must be a JSON/Python list") from exc
    if not isinstance(value, list) or not all(isinstance(c, str) for c in value):
        raise ValueError("choices must be a list of strings")
    return value


def select_pilot(rows: list[dict[str, Any]], root: Path, sound: int, speech: int, seed: int):
    pools: dict[str, list[tuple[dict[str, Any], Path, str]]] = {"sound": [], "speech": []}
    seen_paths: set[str] = set()
    excluded = {"missing": 0, "oversize": 0, "unsupported": 0, "duplicate": 0}

    # Sorting before random sampling means source JSON row order does not affect selection.
    for row in sorted(rows, key=lambda r: (str(r.get("id", "")), str(r.get("audio_id", "")))):
        domain = str(row.get("task", row.get("task_type", ""))).lower().strip()
        if domain not in pools:
            continue
        path, original = audio_location(row, root)
        if original in seen_paths:
            excluded["duplicate"] += 1
            continue
        seen_paths.add(original)
        if not path.is_file():
            excluded["missing"] += 1
            continue
        if path.suffix.lower() != ".wav":
            excluded["unsupported"] += 1
            continue
        if not (0 < path.stat().st_size <= MAX_BYTES):
            excluded["oversize"] += 1
            continue
        with path.open("rb") as f:
            header = f.read(12)
        if len(header) < 12 or header[:4] != b"RIFF" or header[8:] != b"WAVE":
            excluded["unsupported"] += 1
            continue
        pools[domain].append((row, path, original))

    print(f"Eligible sound: {len(pools['sound'])}; speech: {len(pools['speech'])}; exclusions: {excluded}")
    if len(pools["sound"]) < sound or len(pools["speech"]) < speech:
        raise ValueError("Not enough eligible audio files for the exact requested quota. Check paths and 10 MiB upload limit.")
    rng = random.Random(seed)
    sample = rng.sample(pools["sound"], sound) + rng.sample(pools["speech"], speech)
    sample.sort(key=lambda entry: (str(entry[0].get("task")), str(entry[0].get("id"))))
    return sample


def load_early(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    mapping = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(mapping, dict):
        raise ValueError("--early-file must be a JSON object mapping MMAU record IDs to annotations")
    return mapping


def checked_json(response: requests.Response) -> Any:
    try:
        body = response.json()
    except ValueError:
        body = response.text[:500]
    if not response.ok:
        raise RuntimeError(f"HTTP {response.status_code} at {response.url}: {body}")
    return body


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--manifest", required=True, type=Path, help="Local MMAU JSON or JSONL manifest")
    parser.add_argument("--audio-root", required=True, type=Path, help="Root folder containing test-mini-audios/")
    parser.add_argument("--dataset-id", required=True, help="Existing D1 dataset UUID")
    parser.add_argument("--base-url", default="http://localhost:5173")
    parser.add_argument("--sound", type=int, default=60)
    parser.add_argument("--speech", type=int, default=40)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--mode", choices=("audio", "qa", "early", "all"), default="qa",
                        help="audio: bytes only; qa: source question+answer; early: supplied early annotation; all: both")
    parser.add_argument("--early-file", type=Path, help="JSON map of MMAU record id -> pre-existing annotation")
    parser.add_argument("--report", type=Path, default=Path("/tmp/audiolab-mmau-import-report.json"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.sound < 0 or args.speech < 0:
        parser.error("--sound and --speech must be nonnegative")
    root = args.audio_root.expanduser().resolve()
    manifest = args.manifest.expanduser().resolve()
    if not root.is_dir() or not manifest.is_file():
        parser.error("--audio-root must be a directory and --manifest must be an existing file")
    rows = load_rows(manifest)
    selected = select_pilot(rows, root, args.sound, args.speech, args.seed)
    early_map = load_early(args.early_file)

    # Check all inputs before uploading anything.
    for row, _, _ in selected:
        if not row.get("id"):
            raise ValueError("Selected record has no id")
        if args.mode in ("qa", "all"):
            if not isinstance(row.get("question"), str) or not row["question"].strip():
                raise ValueError(f"Selected record {row['id']} has no question")
            choices = parse_choices(row.get("choices"))
            if choices is None or len(choices) < 2:
                raise ValueError(f"Selected record {row['id']} has invalid choices")
        if args.mode in ("early", "all"):
            early_value = early_map.get(str(row["id"]), row.get("early_anno", row.get("early_annotation")))
            if early_value is None:
                raise ValueError(f"No actual early annotation for {row['id']}; provide --early-file or an early_anno field")

    report: dict[str, Any] = {
        "seed": args.seed,
        "mode": args.mode,
        "requested": {"sound": args.sound, "speech": args.speech},
        "datasetId": args.dataset_id,
        "records": [],
    }
    for row, path, original in selected:
        report["records"].append({
            "sourceRecordId": str(row["id"]),
            "sourceDomain": str(row.get("task", row.get("task_type"))),
            "originalPath": original,
            "sizeBytes": path.stat().st_size,
            "status": "selected",
        })

    def save_report():
        args.report.expanduser().parent.mkdir(parents=True, exist_ok=True)
        args.report.expanduser().write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    if args.dry_run:
        save_report()
        print(f"DRY RUN: selected {len(selected)} files. Report: {args.report}")
        return

    base = args.base_url.rstrip("/")
    with requests.Session() as session:
        response = session.get(f"{base}/api/v1/assets", params={"datasetId": args.dataset_id}, timeout=30)
        current = checked_json(response)
        existing = {a["originalPath"]: a["id"] for a in current["assets"]}

        for index, (row, path, original) in enumerate(selected):
            status_row = report["records"][index]
            try:
                asset_id = existing.get(original)
                if asset_id is None:
                    with path.open("rb") as f:
                        upload = session.post(
                            f"{base}/api/v1/assets",
                            data={"datasetId": args.dataset_id, "originalPath": original},
                            files={"audio": (path.name, f, "audio/wav")},
                            timeout=120,
                        )
                    payload = checked_json(upload)
                    asset_id = payload["asset"]["id"]
                    existing[original] = asset_id
                    status_row["status"] = "uploaded"
                else:
                    status_row["status"] = "already_uploaded"
                status_row["assetId"] = asset_id

                if args.mode != "audio":
                    labels: dict[str, Any] = {}
                    if args.mode in ("qa", "all") and row.get("answer") is not None:
                        # Store raw source answer; never expose it from Labeller APIs.
                        labels["referenceAnswer"] = {"value": row["answer"]}
                    if args.mode in ("early", "all"):
                        labels["earlyAnnotation"] = early_map.get(
                            str(row["id"]), row.get("early_anno", row.get("early_annotation"))
                        )
                    source_payload: dict[str, Any] = {
                        "assetId": asset_id,
                        "sourceRecordId": str(row["id"]),
                        "sourceDomain": str(row.get("task", row.get("task_type", "unknown"))).lower(),
                        "metadata": {
                            "originalDataset": row.get("dataset"),
                            "split": row.get("split"),
                            "category": row.get("category"),
                            "subCategory": row.get("sub-category", row.get("sub_category")),
                            "difficulty": row.get("difficulty"),
                        },
                    }
                    if args.mode in ("qa", "all"):
                        source_payload["question"] = row["question"]
                        source_payload["choices"] = parse_choices(row["choices"])
                    if labels:
                        source_payload["labels"] = labels
                    source_response = session.post(
                        f"{base}/api/v1/source-records", json=source_payload, timeout=30
                    )
                    checked_json(source_response)
                    status_row["sourceSaved"] = True

                print(f"[{index+1}/{len(selected)}] {status_row['status']}: {original}")
            except Exception as exc:
                status_row["status"] = "error"
                status_row["error"] = str(exc)
                save_report()
                raise RuntimeError(f"Import stopped at {original}. Completed uploads remain and rerun will reuse them.\n{exc}") from exc
    save_report()
    print(f"SUCCESS: {len(selected)} selected samples processed. Report: {args.report}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, requests.RequestException) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)