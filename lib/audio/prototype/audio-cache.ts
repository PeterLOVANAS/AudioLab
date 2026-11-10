// In-memory, account-scoped, leased resources. No persistent audio or cross-account cache.
type AudioAsset = {
  id: string;
  url: string;
  cache_scope?: string;
  duration: number;
  sample_rate: number;
  channels: number;
};

export type DecodedAudio = {
  peaks: number[];
  rms: number;
  samples: Float32Array;
  waveSamples: Float32Array;
  rate: number;
  waveRate: number;
};

type Resource = {
  url: string;
  decoded: Promise<DecodedAudio>;
};

type Entry = {
  key: string;
  refs: number;
  bytes: number;
  last: number;
  expires: number;
  controller: AbortController;
  promise: Promise<Resource>;
  url?: string;
  failed?: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

const entries = new Map<string, Entry>(),
  LIMIT = 64 * 1024 * 1024,
  TTL = 180000;

function drop(e: Entry) {
  if (e.refs) return;
  clearTimeout(e.timer);
  e.controller.abort();
  if (e.url) URL.revokeObjectURL(e.url);
  if (entries.get(e.key) === e) entries.delete(e.key);
}

function trim() {
  let total = [...entries.values()].reduce((n, e) => n + e.bytes, 0);
  for (const e of [...entries.values()]
    .filter((e) => !e.refs)
    .sort((a, b) => a.last - b.last)) {
    if (total <= LIMIT && entries.size <= 4) break;
    total -= e.bytes;
    drop(e);
  }
}

export function acquireAudio(asset: AudioAsset) {
  const key = (asset.cache_scope || asset.url) + "|" + asset.id;
  let e = entries.get(key);
  if (e && e.expires < Date.now() && !e.refs) {
    drop(e);
    e = undefined;
  }
  if (!e) {
    const controller = new AbortController();
    e = {
      key,
      refs: 0,
      bytes: 0,
      last: Date.now(),
      expires: Date.now() + TTL,
      controller,
      promise: null!,
    };
    const entry = e;

    entry.promise = (async () => {
      const response = await fetch(asset.url, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(
          "Audio unavailable or playback link expired. Reopen this task.",
        );
      const blob = await response.blob();
      if (controller.signal.aborted)
        throw new DOMException("Cancelled", "AbortError");
      entry.bytes = blob.size;
      entry.url = URL.createObjectURL(blob);

      const decoded = (async () => {
        const ctx = new AudioContext({ sampleRate: asset.sample_rate });
        try {
          const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
          if (controller.signal.aborted)
            throw new DOMException("Cancelled", "AbortError");
          const mono = buffer.getChannelData(0).slice(),
            peaks: number[] = [],
            step = Math.max(1, Math.ceil(mono.length / 2200));
          let sum = 0;
          for (let i = 0; i < mono.length; i += step) {
            let peak = 0;
            for (let j = i; j < Math.min(i + step, mono.length); j++) {
              peak = Math.max(peak, Math.abs(mono[j]));
              sum += mono[j] ** 2;
            }
            peaks.push(peak);
          }
          const stride = Math.max(1, Math.ceil(buffer.sampleRate / 16000)),
            down = new Float32Array(Math.floor(mono.length / stride));
          for (let i = 0; i < down.length; i++) {
            let total = 0;
            for (let j = 0; j < stride; j++) total += mono[i * stride + j];
            down[i] = total / stride;
          }
          entry.bytes += mono.byteLength + down.byteLength;
          trim();
          return {
            peaks,
            rms: Math.sqrt(sum / mono.length),
            samples: down,
            waveSamples: mono,
            rate: buffer.sampleRate / stride,
            waveRate: buffer.sampleRate,
          };
        } finally {
          await ctx.close();
        }
      })();
      decoded.catch(() => {
        entry.failed = true;
        if (!entry.refs) drop(entry);
      });
      return { url: entry.url, decoded };
    })();
    entry.promise.catch(() => {
      entry.failed = true;
      drop(entry);
    });
    entries.set(key, entry);
  }

  const entry = e;
  clearTimeout(entry.timer);
  entry.refs++;
  entry.last = Date.now();
  let released = false;
  return {
    promise: entry.promise,
    release() {
      if (released) return;
      released = true;
      entry.refs--;
      entry.last = Date.now();
      if (!entry.refs) {
        if (!entry.url || entry.failed) drop(entry);
        else {
          trim();
          entry.timer = setTimeout(
            () => drop(entry),
            Math.max(0, entry.expires - Date.now()),
          );
        }
      }
    },
  };
}

export function visiblePeaks(
  data: DecodedAudio,
  start: number,
  end: number,
  columns = 1600,
) {
  const a = Math.floor(start * data.waveRate),
    b = Math.min(data.waveSamples.length, Math.ceil(end * data.waveRate)),
    step = Math.max(1, Math.ceil((b - a) / columns)),
    values: number[] = [];
  for (let i = a; i < b; i += step) {
    let peak = 0;
    for (let j = i; j < Math.min(i + step, b); j++)
      peak = Math.max(peak, Math.abs(data.waveSamples[j]));
    values.push(peak);
  }
  return values;
}
