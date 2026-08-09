/** Shared STATE.json serialization and UTF-8 size accounting. */
export const MEMORY_MAX_BYTES = 8_192

/** Serialize memory exactly as it is written to disk. */
export function serializeMemory(mem: unknown): string {
  return JSON.stringify(mem, null, 2)
}

/** Return the UTF-8 byte length of the on-disk memory representation. */
export function memorySizeBytes(mem: unknown): number {
  return Buffer.byteLength(serializeMemory(mem), "utf8")
}
