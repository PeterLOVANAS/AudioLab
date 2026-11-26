/** Read PCM/float RIFF metadata without decoding audio. Chunk padding and JUNK/
 * LIST chunks are respected; unsupported/truncated files fail explicitly.
 * `totalBytes` allows a bounded R2 header read while validating the data extent.
 */
export function readWavMetadata(bytes: Uint8Array, totalBytes = bytes.byteLength) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Expected RIFF/WAVE audio.");
  let format: { sampleRate: number; channels: number; byteRate: number } | undefined;
  let dataSize: number | undefined;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true), start = at + 8;
    if (start + size > totalBytes) throw new Error("Truncated WAV chunk.");
    if (tag(at) === "fmt ") {
      if (size < 16 || start + 16 > bytes.length) throw new Error("Invalid WAV format chunk.");
      const codec = view.getUint16(start, true);
      if (![1, 3, 65534].includes(codec)) throw new Error("Unsupported WAV codec.");
      format = {channels: view.getUint16(start + 2, true), sampleRate: view.getUint32(start + 4, true), byteRate: view.getUint32(start + 8, true)};
    }
    if (tag(at) === "data") dataSize = size;
    if (format && dataSize !== undefined) break;
    at = start + size + size % 2;
  }
  if (!format?.sampleRate || !format.channels || !format.byteRate || !dataSize) throw new Error("WAV format/data not found in header.");
  return { durationSeconds: dataSize / format.byteRate, sampleRate: format.sampleRate, channels: format.channels };
}
