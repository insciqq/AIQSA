import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { PrismaClient } from "@prisma/client";
import { validNormalizedAgent } from "../agents/config";
import { SKILL_BUNDLE_MAX_BYTES, SKILL_FILE_MAX_BYTES, SKILL_MAX_FILES, SKILL_TEXT_FILE_MAX_BYTES } from "../../contracts/skills";
import { skillTarPath, skillWorkspacePath } from "../../domain/skillBundlePaths";
import { tarEndBlocks, tarEntryBlocks } from "../chats/tarArchive";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import { resolveProjectAccess } from "../projects/access";
import type { StorageAdapter } from "../uploads/storage";
import { WorkspaceRuntimeError, type WorkspaceSkillBundleRef } from "../workspace/runtime";
import { renderSkillMarkdown, skillBundleDigest } from "./bundle";
import { createSkillCatalogRepository } from "./catalogRepository";
import { SkillBundleError } from "./bundleErrors";
import { decodeFrozenSkillManifest, type FrozenSkillManifest, type FrozenSkillReference } from "./runManifest";

type RunIdentity = Readonly<{ runId: string; userId: string }>;
export type WorkspaceSkillPlan = Readonly<{
  agent: boolean;
  manifestHash: string;
  initial: readonly WorkspaceSkillBundleRef[];
}>;
export type WorkspaceSkillArchive = Readonly<{
  bundle: WorkspaceSkillBundleRef;
  archive: ReadableStream<Uint8Array>;
  byteSize: number;
  checksum: string;
}>;
export type WorkspaceSkillBundles = Readonly<{
  plan(input: RunIdentity): Promise<WorkspaceSkillPlan>;
  archive(input: RunIdentity & { alias: string; currentAccess?: boolean; signal?: AbortSignal }): Promise<WorkspaceSkillArchive>;
}>;

type Revision = Readonly<{
  id: string; skillId: string; name: string; description: string; instructions: string;
  frontmatterJson: unknown; bundleDigest: string; bundleByteSize: number; bundleReady: boolean; fileCount: number;
  files: readonly Readonly<{
    path: string; byteSize: number; checksum: string; executable: boolean; kind: string;
    textContent: string | null; storageKey: string | null;
  }>[];
}>;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const maximumArchiveBytes = SKILL_BUNDLE_MAX_BYTES + 512 * 1024;

function invalid(): never { throw new WorkspaceRuntimeError("workspace_skill_bundle_invalid"); }
function bounded(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

export function workspaceSkillPath(alias: string): string {
  return skillWorkspacePath(alias) ?? invalid();
}

/** Revalidate persisted metadata before object I/O; never trust import-time checks alone. */
export async function assembleWorkspaceSkillArchive(revision: Revision, storage: StorageAdapter, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  if (!revision.bundleReady || !bounded(revision.fileCount, SKILL_MAX_FILES) || revision.files.length !== revision.fileCount ||
    !bounded(revision.bundleByteSize, SKILL_BUNDLE_MAX_BYTES) || !/^[a-f0-9]{64}$/u.test(revision.bundleDigest)) return invalid();
  const paths = new Set(["skill.md"]);
  let size = Buffer.byteLength(renderSkillMarkdown(revision));
  for (const file of revision.files) {
    const key = file.path.toLowerCase();
    if (!skillTarPath(file.path) || paths.has(key) || !bounded(file.byteSize, SKILL_FILE_MAX_BYTES) ||
      !/^[a-f0-9]{64}$/u.test(file.checksum) || typeof file.executable !== "boolean" ||
      (file.kind === "text" ? typeof file.textContent !== "string" || file.storageKey !== null || file.byteSize > SKILL_TEXT_FILE_MAX_BYTES
        : file.kind !== "binary" || typeof file.storageKey !== "string" || !file.storageKey || file.textContent !== null)) return invalid();
    paths.add(key);
    size += file.byteSize;
    if (size > SKILL_BUNDLE_MAX_BYTES) return invalid();
  }
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index++) if (paths.has(segments.slice(0, index).join("/"))) return invalid();
  }
  if (size !== revision.bundleByteSize || skillBundleDigest(revision) !== revision.bundleDigest) return invalid();
  // Only the guest representation normalizes historical names/descriptions.
  // The immutable revision and its canonical digest remain unchanged.
  const markdown = renderSkillMarkdown({ ...revision, name: [...revision.name].slice(0, 64).join(""),
    description: revision.description || revision.name });
  const mtime = new Date(0);
  const blocks = tarEntryBlocks({ path: "SKILL.md", content: markdown, mtime, mode: 0o644 });
  for (const file of revision.files) {
    signal?.throwIfAborted();
    const bytes = file.kind === "text" ? Buffer.from(file.textContent!, "utf8")
      : (await storage.getObject(file.storageKey!, { maxBytes: Math.max(1, file.byteSize), signal })).body;
    if (bytes.byteLength !== file.byteSize || sha256(bytes) !== file.checksum) return invalid();
    blocks.push(...tarEntryBlocks({ path: file.path, content: bytes, mtime, mode: file.executable ? 0o755 : 0o644 }));
  }
  signal?.throwIfAborted();
  blocks.push(tarEndBlocks());
  const archive = gzipSync(Buffer.concat(blocks));
  if (archive.byteLength > maximumArchiveBytes) throw new WorkspaceRuntimeError("workspace_skill_bundle_limit_exceeded");
  return archive;
}

function references(manifest: FrozenSkillManifest): readonly FrozenSkillReference[] {
  return [...manifest.pinned, ...manifest.available];
}

/** This service has no model-controlled paths or revision selectors. Its aliases
 * resolve only through the private manifest of the exact accepted run. */
export function createWorkspaceSkillBundles(db: PrismaClient, storage: StorageAdapter): WorkspaceSkillBundles {
  async function accepted(input: RunIdentity) {
    const [run, user] = await Promise.all([
      db.modelRun.findFirst({ where: { id: input.runId, userId: input.userId },
        select: { normalizedRequest: true, chat: { select: { userId: true, projectId: true } },
          skillRunBindings: { select: { skillId: true, revisionId: true, mode: true, alias: true } } } }),
      db.user.findUnique({ where: { id: input.userId }, select: { status: true } })
    ]);
    if (!run || user?.status !== "active") return invalid();
    if (run.chat.projectId) {
      if (!await resolveProjectAccess(db, { projectId: run.chat.projectId, userId: input.userId,
        minimumRole: "CONTRIBUTOR", requireActive: true })) return invalid();
    } else if (run.chat.userId !== input.userId) return invalid();
    const request = run.normalizedRequest;
    if (!request || typeof request !== "object" || Array.isArray(request)) return invalid();
    const workspace = request.workspace;
    if (!workspace || typeof workspace !== "object" || Array.isArray(workspace) || workspace.enabled !== true ||
      (request.agent !== undefined && !validNormalizedAgent(request.agent))) return invalid();
    const manifest = decodeFrozenSkillManifest(request.skills);
    if (!manifest) return invalid();
    const all = references(manifest);
    for (const binding of run.skillRunBindings) {
      const reference = all.find(item => item.skillId === binding.skillId && item.revisionId === binding.revisionId);
      if (!reference || binding.alias && binding.alias !== reference.alias ||
        (binding.mode === "pinned" ? !manifest.pinned.some(item => item.skillId === binding.skillId)
          : binding.mode !== "loaded" || !manifest.available.some(item => item.skillId === binding.skillId))) return invalid();
    }
    for (const reference of manifest.pinned) {
      if (!run.skillRunBindings.some(binding => binding.skillId === reference.skillId && binding.revisionId === reference.revisionId && binding.mode === "pinned")) return invalid();
    }
    const agent = request.agent !== undefined;
    return { run, manifest, agent, manifestHash: hashCanonicalMcpValue({
      version: 1, agent, manifest
    }) };
  }

  return {
    async plan(input) {
      const { run, manifest, agent, manifestHash } = await accepted(input);
      const wanted = [...manifest.pinned, ...manifest.available.filter(reference => agent ||
        run.skillRunBindings.some(binding => binding.skillId === reference.skillId && binding.mode === "loaded"))];
      const rows = wanted.length ? await db.skillRevision.findMany({ where: { id: { in: wanted.map(item => item.revisionId) }, bundleReady: true },
        select: { id: true, skillId: true, bundleDigest: true } }) : [];
      const initial = wanted.map(reference => {
        const row = rows.find(item => item.id === reference.revisionId && item.skillId === reference.skillId);
        if (!row || !/^[a-f0-9]{64}$/u.test(row.bundleDigest)) return invalid();
        return { alias: reference.alias, revisionId: reference.revisionId, bundleDigest: row.bundleDigest,
          discover: agent && manifest.available.some(item => item.skillId === reference.skillId) };
      });
      return { agent, manifestHash, initial };
    },
    async archive(input) {
      input.signal?.throwIfAborted();
      workspaceSkillPath(input.alias);
      const { run, manifest, agent } = await accepted(input);
      const reference = references(manifest).find(item => item.alias === input.alias);
      if (!reference) return invalid();
      const available = manifest.available.some(item => item.skillId === reference.skillId);
      if (input.currentAccess || agent && available) {
        if (!await createSkillCatalogRepository(db).resolveFrozen({ userId: input.userId,
          ...(run.chat.projectId ? { projectId: run.chat.projectId } : {}), skillId: reference.skillId, revisionId: reference.revisionId })) {
          throw new SkillBundleError({ code: "skill_not_available" });
        }
      } else if (available && !run.skillRunBindings.some(binding => binding.skillId === reference.skillId && binding.mode === "loaded")) return invalid();
      const revision = await db.skillRevision.findFirst({ where: { id: reference.revisionId, skillId: reference.skillId, bundleReady: true },
        include: { files: { orderBy: { path: "asc" } } } });
      if (!revision) return invalid();
      const bytes = await assembleWorkspaceSkillArchive(revision, storage, input.signal);
      return { bundle: { alias: reference.alias, revisionId: reference.revisionId, bundleDigest: revision.bundleDigest,
        discover: agent && available }, byteSize: bytes.byteLength, checksum: sha256(bytes),
        archive: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
    }
  };
}
