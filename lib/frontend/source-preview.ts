import type {
  SourceFieldPayload,
  WorkerSourcePayload,
  SourcePreviewPayload,
} from "@/lib/contracts/source-fields";
import type { Block } from "@/components/task-builder/model";
import { originalChoiceValue } from "@/lib/contracts/source-reference";
import { resolveBoundBatchBlocks } from "./source-binding";

/**
 * Resolve the administrator's Builder preview using the same opt-in as task
 * capture. Ordinary worker resolution deliberately refuses protected labels.
 * Release only this block's selected choice reference into a temporary copy;
 * never mutate cached source fields or promote sibling private metadata.
 *
 * `access` describes the already authorized preview response, not a new server
 * authorization mechanism. Runtime assignments still use server-pinned inputs.
 */
export function resolveSourcePreviewBlocks(
  blocks: Block[],
  sources: SourcePreviewPayload[],
): Block[] {
  return blocks.map((block) => {
    const previews = sources.map((source) => {
      const fields = source.fields.filter(
        (entry) => entry.field.visibility === "worker",
      );
      if (
        source.access === "admin" &&
        block.trainingAnswerPreview &&
        block.showSourceAnswer &&
        block.sourceBindings?.preview?.fieldId === "reference_answer"
      ) {
        const references = source.fields.filter(
          (entry) =>
            entry.field.id === "reference_answer" &&
            entry.field.type === "json" &&
            entry.field.provenance === "source_labels",
        );
        if (references.length === 1) {
          const value = originalChoiceValue(references[0].value);
          if (value !== null)
            fields.push({
              ...references[0],
              value,
              field: { ...references[0].field, visibility: "worker" },
            });
        }
      }
      return { ...source, fields };
    });
    return resolveBoundBatchBlocks([block], previews)[0];
  });
}

export type PreviewRecord = { sourceRecordId: string; question: string | null };
export type PreviewSlot = {
  assetId: string;
  label: string;
  records: PreviewRecord[];
  recordId: string;
};
type PreviewAsset = { id: string; originalPath: string };
type PreviewReader = <T>(path: string, signal: AbortSignal) => Promise<T>;

/** Resolve authoring-only ordered recording/item pairs through authorized APIs.
 * Multi-question recordings default to the first item ONLY for preview, with
 * explicit selectors returned to the picker. Runtime allocation still pins its
 * own source IDs. Recordless audio supplies no fields; dynamic bindings then
 * report missing fields rather than borrowing another recording's content.
 * Aborted requests must be ignored by the owning React effect.
 */
export async function loadSourcePreviewBatch(
  input: {
    projectId: string;
    datasetId: string;
    memberId: string;
    access: "admin" | "worker";
    assets: PreviewAsset[];
    assetId: string;
    recordId: string;
    count: number;
    selectedRecords: Record<string, string>;
  },
  read: PreviewReader,
  signal: AbortSignal,
): Promise<{ samples: SourcePreviewPayload[]; slots: PreviewSlot[] }> {
  const start = input.assets.findIndex((asset) => asset.id === input.assetId);
  if (start < 0) throw new Error("Choose an available preview recording.");
  const assets = [
    ...input.assets.slice(start),
    ...input.assets.slice(0, start),
  ].slice(0, input.count);
  if (
    assets.length !== input.count ||
    new Set(assets.map((asset) => asset.id)).size !== input.count
  )
    throw new Error(
      `Dataset needs ${input.count} distinct recordings for preview.`,
    );
  const entries = await Promise.all(
    assets.map(async (asset, index) => {
      const { sourceRecords } = await read<{ sourceRecords: PreviewRecord[] }>(
        `source-records?assetId=${encodeURIComponent(asset.id)}`,
        signal,
      );
      const requested =
        index === 0 ? input.recordId : input.selectedRecords[asset.id];
      const recordId = requested || sourceRecords[0]?.sourceRecordId || "";
      if (
        recordId &&
        !sourceRecords.some((record) => record.sourceRecordId === recordId)
      )
        throw new Error(
          `Selected source item is no longer available for ${asset.originalPath}. Choose another item.`,
        );
      const audioUrl = `/api/v1/assets/${asset.id}/audio`;
      let fields: SourcePreviewPayload["fields"] = [];
      if (recordId) {
        const query = new URLSearchParams({
          projectId: input.projectId,
          datasetId: input.datasetId,
          assetId: asset.id,
          recordId,
          userId: input.memberId,
          view: input.access,
        });
        const { source } = await read<{
          source: SourceFieldPayload | WorkerSourcePayload;
        }>(`source-fields?${query}`, signal);
        fields = source.fields;
      }
      return {
        sample: {
          projectId: input.projectId,
          datasetId: input.datasetId,
          recordId,
          access: input.access,
          audioUrl,
          audio: { assetId: asset.id, url: audioUrl },
          fields,
        } satisfies SourcePreviewPayload,
        slot: {
          assetId: asset.id,
          label: asset.originalPath,
          records: sourceRecords,
          recordId,
        },
      };
    }),
  );
  return {
    samples: entries.map((entry) => entry.sample),
    slots: entries.map((entry) => entry.slot),
  };
}
