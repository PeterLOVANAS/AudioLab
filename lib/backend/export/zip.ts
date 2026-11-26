/** Streaming, uncompressed ZIP32 writer. R2 bytes are consumed on demand, not
 * buffered into one giant archive. CRC/data descriptors are standard ZIP records;
 * central-directory metadata is retained until completion. ZIP64 is out of scope.
 */
export type ZipEntry = {
  name: string;
  size: number;
  open: () => Promise<ReadableStream<Uint8Array>>;
};
const encoder = new TextEncoder();
const table = Uint32Array.from({ length: 256 }, (_, value) => {
  let n = value;
  for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n >>> 0;
});
function header(size: number) {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}
function crcUpdate(crc: number, bytes: Uint8Array) {
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
/** Reject traversal and duplicate names before sending any response bytes. */
export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  if (entries.length > 65535) throw new Error("Too many ZIP entries.");
  const names = new Set<string>();
  for (const entry of entries) {
    if (
      !entry.name ||
      entry.name.startsWith("/") ||
      entry.name.includes("\\") ||
      entry.name.split("/").some((part) => part === ".." || part === "") ||
      encoder.encode(entry.name).length > 65535 ||
      names.has(entry.name)
    )
      throw new Error("Invalid or duplicate ZIP path.");
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size >= 0xffffffff
    )
      throw new Error("ZIP32 file size exceeded.");
    names.add(entry.name);
  }
  async function* generate() {
    let offset = 0;
    const central: Uint8Array[] = [];
    for (const entry of entries) {
      const name = encoder.encode(entry.name),
        start = offset,
        h = header(30);
      h.view.setUint32(0, 0x04034b50, true);
      h.view.setUint16(4, 20, true);
      h.view.setUint16(6, 0x808, true);
      h.view.setUint16(12, 33, true);
      h.view.setUint16(26, name.length, true);
      yield h.bytes;
      yield name;
      offset += 30 + name.length;
      const reader = (await entry.open()).getReader();
      let size = 0,
        crc = 0xffffffff,
        complete = false;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) {
            complete = true;
            break;
          }
          size += next.value.byteLength;
          if (size > entry.size)
            throw new Error("Archive input grew while downloading.");
          crc = crcUpdate(crc, next.value);
          yield next.value;
          offset += next.value.byteLength;
        }
      } finally {
        if (!complete) await reader.cancel();
        reader.releaseLock();
      }
      if (size !== entry.size) throw new Error("Archive input was truncated.");
      crc = (crc ^ 0xffffffff) >>> 0;
      const d = header(16);
      d.view.setUint32(0, 0x08074b50, true);
      d.view.setUint32(4, crc, true);
      d.view.setUint32(8, size, true);
      d.view.setUint32(12, size, true);
      yield d.bytes;
      offset += 16;
      const c = header(46 + name.length);
      c.view.setUint32(0, 0x02014b50, true);
      c.view.setUint16(4, 20, true);
      c.view.setUint16(6, 20, true);
      c.view.setUint16(8, 0x808, true);
      c.view.setUint16(14, 33, true);
      c.view.setUint32(16, crc, true);
      c.view.setUint32(20, size, true);
      c.view.setUint32(24, size, true);
      c.view.setUint16(28, name.length, true);
      c.view.setUint32(42, start, true);
      c.bytes.set(name, 46);
      central.push(c.bytes);
    }
    const directory = offset;
    for (const bytes of central) {
      yield bytes;
      offset += bytes.length;
    }
    if (offset >= 0xffffffff) throw new Error("ZIP32 archive size exceeded.");
    const end = header(22);
    end.view.setUint32(0, 0x06054b50, true);
    end.view.setUint16(8, entries.length, true);
    end.view.setUint16(10, entries.length, true);
    end.view.setUint32(12, offset - directory, true);
    end.view.setUint32(16, directory, true);
    yield end.bytes;
  }
  const iterator = generate();
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return();
    },
  });
}
/** Small JSON files share the same streaming interface as R2 objects. */
export function zipBytes(name: string, bytes: Uint8Array): ZipEntry {
  return {
    name,
    size: bytes.length,
    async open() {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
  };
}
