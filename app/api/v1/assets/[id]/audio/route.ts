/*
 * AudioLab 2.0 — Audio Playback API
 *
 * GET /api/v1/assets/:id/audio
 *
 * Streams WAV bytes from R2.
 * Supports ordinary single HTTP byte-range requests.
 *
 * LOCAL DEVELOPMENT ONLY until authorization exists.
 */
// Purpose is to retrive audio on each asset_id
import { env } from "cloudflare:workers";
import { z } from "zod";

import {
  assetService,
  AssetNotFoundError,
} from "@/lib/backend/services/assets";

// Parse a single HTTP byte range.
function parseRange(
  header: string,
  total: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || total <= 0) return null;

  let start: number;
  let end: number;

  if (match[1] === "") {
    // Suffix range, e.g. bytes=-100
    const suffix = Number(match[2]);

    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return null;
    }

    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);

    end = match[2] === "" ? total - 1 : Math.min(Number(match[2]), total - 1);
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= total ||
    end < start
  ) {
    return null;
  }

  return { start, end };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  // Temporary development restriction.
  if (!import.meta.env.DEV) {
    return Response.json(
      { error: "Authentication not configured." },
      { status: 403 },
    );
  }

  const { id } = await context.params;

  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: "Invalid audio asset ID." }, { status: 400 });
  }

  try {
    // 1. Resolve storage metadata from D1.
    const asset = await assetService.get(env.DB, id);

    if (asset.storage.provider !== "r2") {
      return Response.json(
        { error: "Storage provider not yet supported." },
        { status: 501 },
      );
    }

    // 2. Retrieve R2 object metadata.
    const head = await env.AUDIO_BUCKET.head(asset.storage.key);

    if (!head) {
      return Response.json(
        { error: "Audio object is missing from storage." },
        { status: 404 },
      );
    }

    // 3. Interpret an optional byte-range request.
    const rangeHeader = request.headers.get("range");

    const range = rangeHeader ? parseRange(rangeHeader, head.size) : null; // Mean that if rangeHeader is not null, then parseRange() will be called to parse the rangeHeader and determine the requested byte range. If rangeHeader is null, then range will be set to null, indicating that no specific byte range was requested.

    if (rangeHeader && !range) {
      return new Response(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${head.size}`,
          "Accept-Ranges": "bytes",
        },
      });
    }

    // 4. Retrieve bytes from R2. (given the requested range, if any)
    const object = await env.AUDIO_BUCKET.get(
      asset.storage.key,
      range
        ? {
            range: {
              offset: range.start,
              length: range.end - range.start + 1,
            },
          }
        : undefined,
    );

    if (!object || !("body" in object)) {
      return Response.json(
        { error: "Audio content unavailable." },
        { status: 404 },
      );
    }

    // 5. Construct HTTP response headers.
    const headers = new Headers();

    headers.set("Content-Type", "audio/wav");
    headers.set("Accept-Ranges", "bytes");
    headers.set("ETag", object.httpEtag);
    headers.set("Cache-Control", "private, no-store");

    if (range) {
      headers.set(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${head.size}`,
      );

      headers.set("Content-Length", String(range.end - range.start + 1));
    } else {
      headers.set("Content-Length", String(head.size));
    }

    // 6. Stream R2's body directly to the HTTP client.
    return new Response(object.body, {
      status: range ? 206 : 200,
      headers,
    }); // stream instead of converting audio into JSON
  } catch (error) {
    if (error instanceof AssetNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }

    console.error("Audio playback failed:", error);

    return Response.json(
      { error: "Unable to retrieve audio." },
      { status: 500 },
    );
  }
}
