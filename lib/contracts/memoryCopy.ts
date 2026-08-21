export { MEMORY_CONFIRMATION_COPY_VERSION } from "./memoryClient";

export const MEMORY_COPY_KEYS = [
  "archive.action",
  "archive.explanation",
  "restore.action",
  "exclude.action",
  "exclude.explanation",
  "resume.action",
  "resume.explanation",
  "temporary.label",
  "temporary.explanation",
  "temporary.retention",
  "temporary.externalRetention"
] as const;

export type MemoryCopyKey = (typeof MEMORY_COPY_KEYS)[number];
export type MemoryCopyCatalog = Readonly<Record<MemoryCopyKey, string>>;

export const MEMORY_COPY: MemoryCopyCatalog = Object.freeze({
  "archive.action": "Archive",
  "archive.explanation": "Moves this chat out of the active list. The retained chat remains eligible as a Memory source.",
  "exclude.action": "Exclude from Memory",
  "exclude.explanation": "Keeps the chat but immediately stops using it as a source for automatic recall and learning. Archive status does not change.",
  "restore.action": "Restore",
  "resume.action": "Resume Memory for this chat",
  "resume.explanation": "Only new messages sent after you resume can be used for Memory. Earlier excluded messages are not added back automatically.",
  "temporary.explanation": "Temporary Chat reads and writes no personal Memory, cannot be converted to a retained chat, and cannot be shared.",
  "temporary.externalRetention": "External providers and tools may retain data under their disclosed policies; operator backups are a separate domain.",
  "temporary.label": "Temporary Chat",
  "temporary.retention": "The complete chat aggregate is scheduled for durable deletion 24 hours after the last terminal run, or after creation or last local activity if no run settles."
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function memoryCopyCatalogIsComplete(value: unknown): value is MemoryCopyCatalog {
  if (!isRecord(value) || Object.keys(value).length !== MEMORY_COPY_KEYS.length) return false;
  return MEMORY_COPY_KEYS.every((key) => {
    const copy = value[key];
    return typeof copy === "string" && copy.trim().length > 0 && !copy.includes("\u0000");
  });
}

export class MemoryCopyContractError extends Error {
  readonly code = "memory_copy_missing";

  constructor(key: string) {
    super(`Memory copy is missing for ${key}`);
    this.name = "MemoryCopyContractError";
  }
}

export function resolveMemoryCopy(
  key: MemoryCopyKey,
  catalog: unknown = MEMORY_COPY
): string {
  if (!memoryCopyCatalogIsComplete(catalog)) {
    throw new MemoryCopyContractError(key);
  }
  const value = catalog[key];
  if (!value) throw new MemoryCopyContractError(key);
  return value;
}
