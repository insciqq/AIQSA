import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  SKILL_ARCHIVE_MAX_ENTRIES, SKILL_BUNDLE_MAX_BYTES, SKILL_FILE_MAX_BYTES,
  SKILL_INSTRUCTIONS_MAX_BYTES, SKILL_MAX_AVAILABLE, SKILL_MAX_FILES, SKILL_MAX_PINNED
} from "@/lib/contracts/skills";
import { skillTarPath, SKILL_WORKSPACE_DIRECTORY } from "@/lib/domain/skillBundlePaths";
import { WorkspaceRuntimeError, type WorkspaceSkillBundleInstall, type WorkspaceSkillBundleRef,
  type WorkspaceSkillRunIdentity } from "./runtime";

export const WORKSPACE_SKILLS_DIRECTORY = SKILL_WORKSPACE_DIRECTORY;
export const WORKSPACE_SKILLS_DISCOVERY_DIRECTORY = "/root/.agents/skills";
export const SKILL_RUNTIME_CONTENT_MAX_BYTES = SKILL_BUNDLE_MAX_BYTES + 64 * 1024;
export const SKILL_RUNTIME_MARKDOWN_MAX_BYTES = SKILL_INSTRUCTIONS_MAX_BYTES + 64 * 1024;
export const SKILL_RUNTIME_TAR_MAX_BYTES = SKILL_RUNTIME_CONTENT_MAX_BYTES + SKILL_ARCHIVE_MAX_ENTRIES * 1024 + 1024;
export const SKILL_RUNTIME_ARCHIVE_MAX_BYTES = SKILL_RUNTIME_TAR_MAX_BYTES + 64 * 1024;
export const SKILL_RUNTIME_REFS_MAX = SKILL_MAX_AVAILABLE + SKILL_MAX_PINNED;
export const SKILL_RUNTIME_JSON_MAX_BYTES = 128 * 1024;
export const SKILL_RUNTIME_OPERATION_TIMEOUT_MS = 60_000;
const hashPattern = /^[a-f0-9]{64}$/u;

export function skillInvalid(): never { throw new WorkspaceRuntimeError("workspace_skill_bundle_invalid"); }
export function skillLimit(): never { throw new WorkspaceRuntimeError("workspace_skill_bundle_limit_exceeded"); }
export function skillPreparationFailed(): never { throw new WorkspaceRuntimeError("workspace_skills_prepare_failed"); }

export function skillOperationSignal(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(SKILL_RUNTIME_OPERATION_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

export function validateSkillIdentity(input: WorkspaceSkillRunIdentity): void {
  if (![input.sessionId, input.modelRunId, input.runtimeSandboxId].every(value =>
    typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)) ||
    typeof input.manifestHash !== "string" || !hashPattern.test(input.manifestHash)) skillPreparationFailed();
  input.signal?.throwIfAborted();
}

export function parseSkillBundleRef(value: unknown): WorkspaceSkillBundleRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return skillInvalid();
  const ref = value as Record<string, unknown>;
  if (typeof ref.alias !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(ref.alias) || ref.alias.length > 64 ||
    typeof ref.revisionId !== "string" || ref.revisionId.length < 1 || Buffer.byteLength(ref.revisionId) > 128 ||
    /[\u0000-\u001f\u007f]/u.test(ref.revisionId) || typeof ref.bundleDigest !== "string" ||
    !hashPattern.test(ref.bundleDigest) || typeof ref.discover !== "boolean") return skillInvalid();
  return { alias: ref.alias, revisionId: ref.revisionId, bundleDigest: ref.bundleDigest, discover: ref.discover };
}

export function parseSkillInitial(value: unknown): WorkspaceSkillBundleRef[] {
  if (!Array.isArray(value) || value.length > SKILL_RUNTIME_REFS_MAX) return skillInvalid();
  const refs = value.map(parseSkillBundleRef);
  if (new Set(refs.map(ref => ref.alias)).size !== refs.length) return skillInvalid();
  return refs;
}

export function sameSkillRef(a: WorkspaceSkillBundleRef, b: WorkspaceSkillBundleRef): boolean {
  return a.alias === b.alias && a.revisionId === b.revisionId && a.bundleDigest === b.bundleDigest && a.discover === b.discover;
}

export function validateSkillArchiveMetadata(input: Pick<WorkspaceSkillBundleInstall, "byteSize" | "checksum">): void {
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || !hashPattern.test(input.checksum)) skillInvalid();
  if (input.byteSize > SKILL_RUNTIME_ARCHIVE_MAX_BYTES) skillLimit();
}

export async function readSkillArchive(input: WorkspaceSkillBundleInstall): Promise<Buffer> {
  validateSkillArchiveMetadata(input);
  const reader = input.archive.getReader();
  const chunks: Uint8Array[] = [];
  const digest = createHash("sha256");
  let count = 0;
  let complete = false;
  const abort = () => void reader.cancel().catch(() => undefined);
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      input.signal?.throwIfAborted();
      const next = await reader.read();
      input.signal?.throwIfAborted();
      if (next.done) break;
      count += next.value.byteLength;
      if (count > input.byteSize) skillLimit();
      digest.update(next.value); chunks.push(next.value);
    }
    if (count !== input.byteSize || digest.digest("hex") !== input.checksum) skillInvalid();
    complete = true;
    return Buffer.concat(chunks, count);
  } finally {
    input.signal?.removeEventListener("abort", abort);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export type SkillArchiveEntry = Readonly<{ path: string; content: Uint8Array; mode: 0o644 | 0o755; directory: boolean }>;

/** Strict ustar subset shared by the deterministic receiver and real preflight. */
export function parseSkillArchive(archive: Uint8Array): SkillArchiveEntry[] {
  let tar: Uint8Array;
  try { tar = gunzipSync(archive, { maxOutputLength: SKILL_RUNTIME_TAR_MAX_BYTES }); }
  catch { return skillInvalid(); }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const field = (header: Uint8Array, start: number, size: number): string => {
    const bytes = header.subarray(start, start + size);
    const end = bytes.indexOf(0);
    if (end >= 0 && bytes.subarray(end).some(byte => byte !== 0)) return skillInvalid();
    try { return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end)); } catch { return skillInvalid(); }
  };
  const number = (header: Uint8Array, start: number, size: number): number => {
    const value = new TextDecoder().decode(header.subarray(start, start + size)).replace(/\0.*$/su, "").trim();
    if (!/^[0-7]+$/u.test(value)) return skillInvalid();
    const parsed = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(parsed)) return skillInvalid();
    return parsed;
  };
  const entries: SkillArchiveEntry[] = [];
  const seen = new Set<string>();
  const tree = new Map<string, { path: string; directory: boolean }>();
  let offset = 0; let total = 0; let files = 0; let ended = false;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) {
      if (offset + 512 > tar.byteLength || tar.subarray(offset).some(byte => byte !== 0)) return skillInvalid();
      ended = true; break;
    }
    if (entries.length >= SKILL_ARCHIVE_MAX_ENTRIES) return skillLimit();
    if (field(header, 257, 6) !== "ustar" || field(header, 263, 2) !== "00" ||
      number(header, 148, 8) !== header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)) return skillInvalid();
    const name = field(header, 0, 100); const prefix = field(header, 345, 155);
    const directory = header[156] === 0x35;
    if (!directory && header[156] !== 0x30 && header[156] !== 0) return skillInvalid();
    const combined = `${prefix ? prefix + "/" : ""}${name}`;
    const path = directory ? combined.replace(/\/$/u, "") : combined;
    if (!skillTarPath(path) || seen.has(path.toLowerCase()) || field(header, 157, 100)) return skillInvalid();
    seen.add(path.toLowerCase());
    const segments = path.split("/");
    for (let index = 1; index <= segments.length; index++) {
      const part = segments.slice(0, index).join("/"); const key = part.toLowerCase();
      const isDirectory = index < segments.length || directory; const prior = tree.get(key);
      if (prior && (prior.path !== part || !prior.directory || !isDirectory)) return skillInvalid();
      tree.set(key, { path: part, directory: isDirectory });
    }
    const size = number(header, 124, 12); const mode = number(header, 100, 8);
    if ((directory && (size !== 0 || mode !== 0o755)) || (!directory && mode !== 0o644 && mode !== 0o755)) return skillInvalid();
    if (!directory && ++files > SKILL_MAX_FILES + 1) return skillLimit();
    if (size > (path === "SKILL.md" ? SKILL_RUNTIME_MARKDOWN_MAX_BYTES : SKILL_FILE_MAX_BYTES)) return skillLimit();
    total += size; if (total > SKILL_RUNTIME_CONTENT_MAX_BYTES) return skillLimit();
    const next = offset + Math.ceil(size / 512) * 512;
    if (next > tar.byteLength || tar.subarray(offset + size, next).some(byte => byte !== 0)) return skillInvalid();
    entries.push({ path, mode: mode as 0o644 | 0o755, directory, content: tar.subarray(offset, offset + size) });
    offset = next;
  }
  if (!ended || !entries.some(entry => entry.path === "SKILL.md" && !entry.directory)) return skillInvalid();
  return entries;
}
