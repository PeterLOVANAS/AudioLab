/** Reuse source_records/source_labels; a transaction prevents partial metadata/label imports. */
export const ingestionRepository = {
  async persist(
    db: D1Database,
    rows: Array<{
      id: string;
      dataset: string;
      audio: string;
      record: string;
      json: string;
      hash: string;
      annotations: unknown;
      reference: unknown;
      provenance: string;
    }>,
  ) {
    const statements = rows.flatMap((r) => [
      db
        .prepare(
          `INSERT INTO source_records(id,asset_id,source_record_id,source_domain,canonical_json,ingestion_hash,canonical_dataset_id)
    VALUES(?,?,?,'unknown',?,?,?) ON CONFLICT(asset_id,source_record_id) DO NOTHING`,
        )
        .bind(r.id, r.audio, r.record, r.json, r.hash, r.dataset),
      ...(
        [
          ["early_annotation", r.annotations],
          ["reference_answer", r.reference],
        ] as const
      )
        .filter(([, v]) => v !== undefined)
        .map(([kind, value]) =>
          db
            .prepare(
              `INSERT INTO source_labels(id,source_record_id,kind,payload_json,provenance) VALUES(?,?,?,?,?)
     ON CONFLICT(source_record_id,kind) DO NOTHING`,
            )
            .bind(
              r.id + "::" + kind,
              r.id,
              kind,
              JSON.stringify(value),
              r.provenance,
            ),
        ),
    ]);
    // D1 batch is atomic. A concurrent conflicting import aborts via SQL trigger.
    return db.batch(statements);
  },
};
