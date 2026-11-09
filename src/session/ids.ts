import { createHash } from "node:crypto";

/**
 * Turns a harness id into a stable, opaque one. The same input always gives the same output,
 * so re-ingesting a transcript never creates duplicates, but the raw id is never stored.
 */
export function hashId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}
