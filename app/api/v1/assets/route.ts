/*
 * AudioLab 2.0 — Audio Assets API
 *
 * GET  /api/v1/assets?datasetId=...
 * POST /api/v1/assets
 *
 * Admin dataset ownership is verified before bounded multipart parsing.
 * Labellers stream only audio attached to their assigned tasks.
 */

import { env } from "cloudflare:workers";
import { z } from "zod";

import {
  assetService,
  MAX_AUDIO_BYTES,
  DatasetNotFoundError,
  DuplicateAssetError,
  InvalidAudioError,
} from "@/lib/backend/services/assets";

// Production identity/project scope is enforced in proxy.ts.
// Session identity and resource permissions are enforced by the mandatory API proxy.

// GET: List recordings in one dataset.
export async function GET(request: Request) {

  const url = new URL(request.url);
  const datasetId = url.searchParams.get("datasetId");

  // zod validation for datasetId
  if (!z.uuid().safeParse(datasetId).success) {
    return Response.json(
      { error: "A valid datasetId is required." },
      { status: 400 },
    );
  }

  try {
    const assets = await assetService.list(env.DB, datasetId!);

    return Response.json({ assets });
  } catch (error) {
    if (error instanceof DatasetNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }

    console.error("GET assets failed:", error);

    return Response.json(
      { error: "Unable to list audio assets." },
      { status: 500 },
    );
  }
}

// POST: Upload one WAV recording.
export async function POST(request: Request) {

  // An early size check before parsing multipart data.
  // Some clients may omit Content-Length, so this alone
  // is not a complete streaming upload limit.
  const contentLength = Number(request.headers.get("content-length") ?? 0);

  if (contentLength > MAX_AUDIO_BYTES + 1024 * 1024) {
    return Response.json(
      { error: "Upload request is too large." },
      { status: 413 },
    );
  }

  let form: FormData;

  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "Expected multipart/form-data." },
      { status: 400 },
    );
  }

  const datasetId = form.get("datasetId");
  const audio = form.get("audio");
  const originalPath = form.get("originalPath");

  // Validate ordinary form fields.
  if (typeof datasetId !== "string" || !z.uuid().safeParse(datasetId).success) {
    return Response.json(
      { error: "A valid datasetId is required." },
      { status: 400 },
    );
  }

  if (!(audio instanceof File)) {
    return Response.json(
      { error: "An audio file is required." },
      { status: 400 },
    );
  }

  if (
    originalPath !== null &&
    (typeof originalPath !== "string" ||
      originalPath.trim().length === 0 ||
      originalPath.length > 500)
  ) {
    return Response.json({ error: "Invalid originalPath." }, { status: 400 });
  }

  try {
    const asset = await assetService.upload(env.DB, env.AUDIO_BUCKET, {
      datasetId,
      audio,
      originalPath: originalPath ?? undefined,
    });

    return Response.json({ asset }, { status: 201 });
  } catch (error) {
    if (error instanceof DatasetNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }

    if (error instanceof DuplicateAssetError) {
      return Response.json({ error: error.message }, { status: 409 });
    }

    if (error instanceof InvalidAudioError) {
      return Response.json(
        { error: error.message },
        {
          status: audio.size > MAX_AUDIO_BYTES ? 413 : 400,
        },
      );
    }

    console.error("POST assets failed:", error);

    return Response.json({ error: "Unable to upload audio." }, { status: 500 });
  }
}
