import type { RequestAuthResolver } from "../auth/requestAuth";
import { readBoundedFormData, RequestBodyTooLargeError } from "../http/requestBody";
import { getRequestBodyConfig } from "../http/requestBodyConfig";
import { resolveUploadPermitGate } from "../http/uploadPermitGate";
import { defaultUploadMaxBytes } from "../uploads/validation";
import { SKILL_ARCHIVE_MAX_ENTRIES, SKILL_FILE_MAX_BYTES } from "../../contracts/skills";
import { skillTarPath } from "../../domain/skillBundlePaths";
import { parseSkillImport } from "./bundle";
import { SkillBundleError, skillLimit } from "./bundleErrors";
import type { SkillBundleService } from "./bundleService";
import { readSkillZip, type SkillImportFile } from "./zipReader";

export type SkillBundleHandlerDeps = {
  resolveAuth: RequestAuthResolver;
  service: () => SkillBundleService;
  getMaxBytes?: () => number;
};
type SkillContext = { params: Promise<{ skillId: string }> | { skillId: string } };
const unavailable = () => Response.json({ error: "unauthorized" }, { status: 401 });

function errorResponse(error: unknown): Response {
  if (error instanceof RequestBodyTooLargeError) return Response.json({ error: "file_too_large", limit: error.limitBytes }, { status: 413 });
  const issue = error instanceof SkillBundleError ? error.issue : { code: "skill_operation_failed" };
  const { code, ...details } = issue;
  return Response.json({ error: code, ...details }, {
    status: ["skill_not_available", "skill_file_not_found"].includes(code) ? 404 : code === "skill_operation_failed" ? 503 : 400,
    headers: { "cache-control": "no-store" }
  });
}

export function createImportSkillsHandler(deps: SkillBundleHandlerDeps) {
  return async function POST(request: Request) {
    const session = await deps.resolveAuth(request);
    if (!session) return unavailable();
    const maxBytes = deps.getMaxBytes?.() ?? defaultUploadMaxBytes();
    const config = getRequestBodyConfig(process.env, maxBytes);
    const release = resolveUploadPermitGate(config.uploadMaxConcurrency).tryAcquire();
    if (!release) return Response.json({ error: "upload_busy" }, { status: 429, headers: { "retry-after": "1" } });
    try {
      const form = await readBoundedFormData(request, config.uploadMultipartMaxBytes);
      const parts = [...form.entries()];
      if (!parts.length || parts.some(([, value]) => !(value instanceof File))) throw new SkillBundleError({ code: "skill_file_required" });
      skillLimit("archiveEntries", parts.length, SKILL_ARCHIVE_MAX_ENTRIES);
      let total = 0;
      const files: SkillImportFile[] = [];
      for (const [key, value] of parts) {
        const file = value as File;
        total += file.size;
        skillLimit("uploadBytes", total, maxBytes);
        const path = key === "file" || key === "files" ? file.name : key;
        const zip = parts.length === 1 && path.toLowerCase().endsWith(".zip");
        if (!zip) skillLimit("fileBytes", file.size, SKILL_FILE_MAX_BYTES);
        const bytes = Buffer.from(await file.arrayBuffer());
        if (zip) files.push(...readSkillZip(bytes));
        else files.push({ path, bytes });
      }
      const parsed = parseSkillImport(files);
      const response = await deps.service().importCandidates(session.userId, parsed.candidates, parsed.ignoredFiles);
      return Response.json(response, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (request.signal.aborted) throw error;
      return errorResponse(error);
    } finally { release(); }
  };
}

export function createExportSkillsHandler(deps: SkillBundleHandlerDeps) {
  return async function GET(request: Request, context?: SkillContext) {
    const session = await deps.resolveAuth(request);
    if (!session) return unavailable();
    try {
      const maxBytes = deps.getMaxBytes?.() ?? defaultUploadMaxBytes();
      const multipartMaxBytes = getRequestBodyConfig(process.env, maxBytes).uploadMultipartMaxBytes;
      const skillId = context ? (await context.params).skillId : undefined;
      const archive = await deps.service().exportOwned(session.userId, skillId, Math.max(0, Math.min(maxBytes, multipartMaxBytes - 65_536)));
      return new Response(new Uint8Array(archive), { headers: {
        "content-type": "application/zip", "content-disposition": 'attachment; filename="skills.zip"',
        "cache-control": "no-store", "x-content-type-options": "nosniff"
      } });
    } catch (error) { return errorResponse(error); }
  };
}

export function createReadSkillFileHandler(deps: SkillBundleHandlerDeps) {
  return async function GET(request: Request, context: SkillContext) {
    const session = await deps.resolveAuth(request);
    if (!session) return unavailable();
    try {
      const query = new URL(request.url).searchParams;
      const path = query.get("path") ?? "";
      if ([...query.keys()].some((key) => key !== "path") || query.getAll("path").length !== 1 || !skillTarPath(path)) {
        throw new SkillBundleError({ code: "skill_path_invalid" });
      }
      return Response.json(await deps.service().readFile(session.userId, (await context.params).skillId, path), {
        headers: { "cache-control": "no-store" }
      });
    } catch (error) { return errorResponse(error); }
  };
}
