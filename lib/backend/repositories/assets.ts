
/*
 * AudioLab 2.0 — Audio Asset Repository
 *
 * Responsibilities:
 * - Verify dataset existence
 * - Insert audio asset metadata
 * - List audio assets
 * - Find one asset by its ID
 *
 * Actual WAV bytes live in R2, not D1.
 */

import type { AudioAsset } from "@/lib/contracts/datasets";

// Our first uploader creates R2-backed assets.
// The contract still supports other storage providers.
export type NewStoredAsset = {
  id: string;
  datasetId: string;
  originalPath: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

// Shape of the data returned from SQL.
type AssetRow = {
  id: string;
  datasetId: string;
  originalPath: string;
  storageProvider: "local" | "r2" | "s3";
  storageKey: string;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
};

// Map SQL columns into our frontend-facing contract.
function toAudioAsset(row: AssetRow): AudioAsset {
  return {
    id: row.id,
    datasetId: row.datasetId,
    originalPath: row.originalPath,

    storage: {
      provider: row.storageProvider,
      key: row.storageKey,
    },

    mimeType: row.mimeType ?? undefined,
    sizeBytes: row.sizeBytes ?? undefined,
    sha256: row.sha256 ?? undefined,
  };
}

// Reuse this SELECT to keep database reads consistent.
const ASSET_SELECT = `
  SELECT
    id,
    dataset_id AS datasetId,
    original_path AS originalPath,
    storage_provider AS storageProvider,
    storage_key AS storageKey,
    mime_type AS mimeType,
    size_bytes AS sizeBytes,
    sha256
  FROM audio_assets
`;

export const assetRepository = {

  // Check whether a dataset exists.
  async datasetExists(
    db: D1Database,
    datasetId: string
  ): Promise<boolean> {
    const row = await db.prepare(
      `SELECT id FROM datasets WHERE id = ?`
    ).bind(datasetId).first<{ id: string }>();

    return row !== null;
  },

  // List assets belonging to one dataset.
  async findByDataset(
    db: D1Database,
    datasetId: string
  ): Promise<AudioAsset[]> {
    const result = await db.prepare(
      `${ASSET_SELECT}
       WHERE dataset_id = ?
       ORDER BY original_path ASC`
    ).bind(datasetId).all<AssetRow>();

    return result.results.map(toAudioAsset);
  },

  // Retrieve one asset by ID.
  async findById(
    db: D1Database,
    assetId: string
  ): Promise<AudioAsset | null> {
    const row = await db.prepare(
      `${ASSET_SELECT}
       WHERE id = ?`
    ).bind(assetId).first<AssetRow>();

    return row ? toAudioAsset(row) : null;
  },

  // Insert metadata after the audio has been stored.
  async insert(
    db: D1Database,
    asset: NewStoredAsset
  ): Promise<boolean> {
    const result = await db.prepare(
      `INSERT INTO audio_assets (
        id,
        dataset_id,
        original_path,
        storage_provider,
        storage_key,
        mime_type,
        size_bytes,
        sha256
      )
      VALUES (?, ?, ?, 'r2', ?, ?, ?, ?)
      ON CONFLICT(dataset_id, original_path) DO NOTHING`
    ).bind(
      asset.id,
      asset.datasetId,
      asset.originalPath,
      asset.storageKey,
      asset.mimeType,
      asset.sizeBytes,
      asset.sha256
    ).run();

    return result.meta.changes === 1;
  },
};
