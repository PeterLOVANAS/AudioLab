/**
 * Adapt ordered R2-backed task assets to the SAME props as the Task Builder preview.
 * URL strings are references, NOT downloaded byte buffers.
 */
import type { TaskInstancePreview } from "@/lib/contracts/task-instances";
import type { Block } from "@/components/task-builder/model";
import type { Samples } from "@/components/workbench/BlockFields";

export function toLabellerSamples(
  task: TaskInstancePreview,
  blocks: Block[],
): Samples {
  const assets = task.audioAssets?.length
    ? [...task.audioAssets].sort((a, b) => a.position - b.position)
    : [{ id: task.assetId, url: task.audioUrl, position: 0 }];
  // Asset metadata belongs to the recording, never to the published form.
  const primary = task.audioAssets?.find(asset => asset.id === task.assetId);
  const primaryMeta = primary ? {
    durationSeconds: primary.durationSeconds ?? undefined,
    sampleRate: primary.sampleRate ?? undefined,
    channels: primary.channels ?? undefined,
  } : undefined;
  const batchAudio = assets.map((asset, index) => ({
    id: asset.id,
    url: asset.url,
    label: `Audio ${index + 1}`,
    durationSeconds: "durationSeconds" in asset ? asset.durationSeconds ?? undefined : undefined,
    sampleRate: "sampleRate" in asset ? asset.sampleRate ?? undefined : undefined,
    channels: "channels" in asset ? asset.channels ?? undefined : undefined,
  }));
  const audio: Record<string, string> = {};
  for (const block of blocks) {
    // Legacy single-recording player names and ranking labels both use these keys.
    (block.stimulusSlots ?? []).forEach((slot, index) => {
      if (batchAudio[index] && !audio[slot])
        audio[slot] = batchAudio[index].url;
    });
    if (block.stimulusSlot && !audio[block.stimulusSlot]) {
      // A named assetId or explicit "primary" is safe to resolve; an unknown
      // named slot must remain unbound instead of playing the WRONG recording.
      const matched = batchAudio.find((item) => item.id === block.stimulusSlot);
      if (matched) audio[block.stimulusSlot] = matched.url;
      else if (block.stimulusSlot === "primary" && batchAudio[0])
        audio.primary = batchAudio[0].url;
    }
  }
  // V4 curated candidates are independent from private MMAU reference answers.
  // V4 currently exposes one candidate to the shared renderer; do not silently
  // pick a ground-truth label as a substitute.
  const candidate = task.candidates?.[0];
  return {
    primaryUrl: task.audioUrl,
    primaryMeta,
    batchAudio,
    audio,
    candidateSets: task.candidateSets,
    candidateId: candidate?.id,
    candidateText: candidate?.label,
  };
}
