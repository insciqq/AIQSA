import type { PrismaClient } from "@prisma/client";
import {
  decodeSkillImportSource, decodeSkillSourceImportRequest, decodeSkillSourcePreviewRequest,
  SKILL_SOURCE_MAX_SELECTIONS, type SkillSourceImportRequest, type SkillSourcePreview, type SkillSourcePreviewRequest
} from "../../contracts/skillSources";
import type { SkillImportResponse } from "../../contracts/skills";
import { SkillBundleError } from "./bundleErrors";
import type { SkillBundleService } from "./bundleService";
import { fetchRemoteSkillSource } from "./remoteSource";

export function createRemoteSkillImportService(
  db: PrismaClient,
  bundles: Pick<SkillBundleService, "importRemoteCandidate">,
  fetchSource: typeof fetchRemoteSkillSource = fetchRemoteSkillSource
) {
  async function targets(userId: string, ids: string[], names: string[] = []) {
    const rows = await db.skillDefinition.findMany({ where: {
      ownerUserId: userId, archivedAt: null, deletedAt: null, currentRevisionId: { not: null },
      OR: [{ id: { in: ids } }, ...(names.length ? [{ currentRevision: { name: { in: names } } }] : [])]
    }, select: { id: true, version: true, importSourceJson: true, currentRevision: { select: { name: true, bundleDigest: true } } },
    orderBy: { id: "asc" }, take: SKILL_SOURCE_MAX_SELECTIONS + 1 });
    if (rows.length > SKILL_SOURCE_MAX_SELECTIONS) throw new SkillBundleError({ code: "skill_source_matches_limit" });
    return rows;
  }

  async function preview(userId: string, request: SkillSourcePreviewRequest, options: { signal?: AbortSignal } = {}): Promise<SkillSourcePreview> {
    const input = decodeSkillSourcePreviewRequest(request);
    if (!input) throw new SkillBundleError({ code: "skill_source_request_invalid" });
    const target = input.targetSkillId ? (await targets(userId, [input.targetSkillId]))[0] : undefined;
    const previous = target ? decodeSkillImportSource(target.importSourceJson) : null;
    if (input.targetSkillId && (!target || !previous)) throw new SkillBundleError({ code: "skill_not_available" });
    if (previous && input.url !== previous.url) throw new SkillBundleError({ code: "skill_source_request_invalid" });
    const result = await fetchSource(input.url, options);
    const matches = await targets(userId, [], result.candidates.flatMap(({ candidate }) => candidate.bundle ? [candidate.bundle.name] : []));
    return {
      source: result.source, fingerprint: result.fingerprint, ignoredFiles: result.ignoredFiles,
      candidates: result.candidates.map(({ path, candidate }) => ({
        path, name: candidate.name,
        matches: matches.filter((row) => row.currentRevision?.name === candidate.name).map((row) => ({ id: row.id, name: row.currentRevision!.name, version: row.version })),
        ...(candidate.error ? { error: candidate.error } : {
          bundleDigest: candidate.bundle.bundleDigest, description: candidate.bundle.description,
          fileCount: candidate.bundle.fileCount, totalBytes: candidate.bundle.bundleByteSize, hasExecutables: candidate.bundle.hasExecutables
        })
      })),
      ...(target && previous ? { target: { id: target.id, name: target.currentRevision!.name, version: target.version,
        path: previous.path, locallyModified: target.currentRevision!.bundleDigest !== previous.bundleDigest } } : {})
    };
  }

  async function importSelected(userId: string, request: SkillSourceImportRequest, options: { signal?: AbortSignal } = {}): Promise<SkillImportResponse> {
    const input = decodeSkillSourceImportRequest(request);
    if (!input) throw new SkillBundleError({ code: "skill_source_request_invalid" });
    const updates = input.selections.flatMap(({ action }) => action.kind === "update" ? [action] : []);
    const owned = await targets(userId, updates.map((action) => action.skillId));
    // Check every target before remote I/O or any staging. The bundle service
    // repeats these checks under the write lock and fences publication after I/O.
    for (const action of updates) {
      const target = owned.find((row) => row.id === action.skillId);
      if (!target) throw new SkillBundleError({ code: "skill_not_available" });
      if (target.version !== action.version) throw new SkillBundleError({ code: "skill_version_conflict" });
    }
    const result = await fetchSource(input.url, options);
    if (result.fingerprint !== input.fingerprint) throw new SkillBundleError({ code: "skill_source_changed" });
    const selected = input.selections.map((selection) => {
      const found = result.candidates.find((candidate) => candidate.path === selection.path)?.candidate;
      if (!found?.bundle || found.bundle.bundleDigest !== selection.bundleDigest) throw new SkillBundleError({ code: "skill_source_changed" });
      return { ...selection, bundle: found.bundle };
    });
    const results: SkillImportResponse["results"] = [];
    for (const selection of selected) {
      options.signal?.throwIfAborted();
      try {
        const outcome = await bundles.importRemoteCandidate(userId, selection.bundle, selection.action,
          { ...result.source, path: selection.path, bundleDigest: selection.bundle.bundleDigest });
        results.push({ name: selection.bundle.name, ...outcome });
      } catch (error) {
        results.push({ name: selection.bundle.name, outcome: "failed", error: error instanceof SkillBundleError ? error.issue : { code: "skill_import_failed" } });
      }
    }
    return { results, ignoredFiles: result.ignoredFiles };
  }
  return { preview, importSelected };
}

export type RemoteSkillImportService = ReturnType<typeof createRemoteSkillImportService>;
