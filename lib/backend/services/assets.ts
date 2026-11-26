/*
 * AudioLab 2.0 — Audio Asset Service
 *
 * Coordinates R2 object storage and D1 metadata.
 *
 * This first implementation supports small RIFF/WAVE
 * files for local development.
 */

import { readWavMetadata } from "@/lib/audio/wav-metadata";
import type { AudioAsset } from "@/lib/contracts/datasets";

import { assetRepository } from "@/lib/backend/repositories/assets";

// Maximum file size for this initial upload method.
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

// Business-level errors.
export class DatasetNotFoundError extends Error {}
export class AssetNotFoundError extends Error {}
export class DuplicateAssetError extends Error {}
export class InvalidAudioError extends Error {}

export type UploadAudioInput = {
  datasetId: string;
  audio: File;
  originalPath?: string;
};

// Validate the RIFF/WAVE file signature.
// This checks file identification, not the entire audio codec.
function isWave(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;

  const text = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));

  return text(0, 4) === "RIFF" && text(8, 12) === "WAVE";
}

// Compute a SHA-256 digest for provenance and integrity.
async function calculateSHA256(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export const assetService = {
  // ------------------------------------------
  // LIST: Read dataset metadata from D1
  // ------------------------------------------

  async list(db: D1Database, datasetId: string): Promise<AudioAsset[]> {
    const exists = await assetRepository.datasetExists(db, datasetId);

    if (!exists) {
      throw new DatasetNotFoundError("Dataset not found.");
    }

    return assetRepository.findByDataset(db, datasetId);
  },

  // ------------------------------------------
  // UPLOAD: Save audio and register metadata
  // ------------------------------------------

  async upload(
    db: D1Database,
    bucket: R2Bucket,
    input: UploadAudioInput,
  ): Promise<AudioAsset> {
    // 1. Verify the parent dataset.
    if (!(await assetRepository.datasetExists(db, input.datasetId))) {
      throw new DatasetNotFoundError("Dataset not found.");
    }

    // 2. Validate the filename and file size.
    if (
      !input.audio.name.toLowerCase().endsWith(".wav") ||
      input.audio.size === 0 ||
      input.audio.size > MAX_AUDIO_BYTES
    ) {
      throw new InvalidAudioError(
        "Provide a non-empty WAV file smaller than 10 MiB.",
      );
    }

    // 3. Read the file and verify its basic signature.
    const bytes = new Uint8Array(await input.audio.arrayBuffer());

    if (!isWave(bytes)) {
      throw new InvalidAudioError(
        "The file is not a supported RIFF/WAVE recording.",
      );
    }

    let metadata: ReturnType<typeof readWavMetadata>;
    try { metadata = readWavMetadata(bytes); }
    catch (error) { throw new InvalidAudioError(error instanceof Error ? error.message : "Invalid WAV metadata."); }

    // 4. Generate an identity independent of the filename.
    const id = crypto.randomUUID();

    // Never use an untrusted upload filename as an R2 key.
    const storageKey = `datasets/${input.datasetId}/assets/${id}.wav`;

    // Preserve the original path only as metadata.
    const originalPath = input.originalPath ?? input.audio.name;

    const sha256 = await calculateSHA256(bytes);

    // 5. Store the WAV bytes in R2.
    const stored = await bucket.put(storageKey, bytes, {
      httpMetadata: {
        contentType: "audio/wav",
      },
    });

    if (!stored) {
      throw new Error("Unable to store audio in R2.");
    }

    // 6. Register metadata in D1.
    try {
      const inserted = await assetRepository.insert(db, {
        id,
        datasetId: input.datasetId,
        originalPath,
        storageKey,
        mimeType: "audio/wav",
        sizeBytes: bytes.byteLength,
        sha256,
        ...metadata,
      });

      if (!inserted) {
        throw new DuplicateAssetError(
          "This original audio path is already registered.",
        );
      }
    } catch (error) {
      // Best-effort compensation:
      // If the SQL insert fails, remove the new R2 object.
      try {
        await bucket.delete(storageKey);
      } catch (cleanupError) {
        console.error("R2 cleanup failed:", cleanupError);
      }

      throw error;
    }

    // 7. Return the saved asset's public metadata.
    return {
      id,
      datasetId: input.datasetId,
      originalPath,
      storage: {
        provider: "r2",
        key: storageKey,
      },
      mimeType: "audio/wav",
      sizeBytes: bytes.byteLength,
      sha256,
      ...metadata,
    };
  },

  // ------------------------------------------
  // LOOKUP: Resolve one asset
  // ------------------------------------------

  async get(db: D1Database, assetId: string): Promise<AudioAsset> {
    const asset = await assetRepository.findById(db, assetId);

    if (!asset) {
      throw new AssetNotFoundError("Audio asset not found.");
    }

    return asset;
  },
};
