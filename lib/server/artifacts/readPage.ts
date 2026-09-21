import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ARTIFACT_LIMITS, normalizedArtifactPath } from "@/lib/contracts/artifacts";
import { getAuthConfig } from "../auth/config";
import type { ArtifactBundle } from "./bundle";
import { ArtifactToolError } from "./errors";

type Fragment = { path: string; mimeType: string; bytes: number; offset: number; text?: string; binary?: true };
const invalid = (): never => { throw new ArtifactToolError("artifact_read_cursor_invalid", { hint: "Use the unchanged next_cursor with the same artifact and paths from the previous read_artifact result." }); };

export function artifactReadPage(input: { artifactId: string; versionId: string; ownerUserId: string; bundle: ArtifactBundle; args: Record<string, unknown>; secret?: string; maxBytes?: number }) {
  const maxBytes = Math.min(ARTIFACT_LIMITS.maxReadBytes, input.maxBytes ?? ARTIFACT_LIMITS.maxReadBytes);
  if (Object.keys(input.args).some(key => !["artifact_id", "paths", "cursor"].includes(key))) invalid();
  const paths = input.args.paths;
  if (paths !== undefined && (!Array.isArray(paths) || !paths.length || paths.length > ARTIFACT_LIMITS.maxFiles || paths.some(path => normalizedArtifactPath(path) !== path))) invalid();
  const selected = paths as string[] | undefined;
  if (selected && (new Set(selected).size !== selected.length || selected.some(path => !input.bundle.files.some(file => file.path === path)))) invalid();
  const files = input.bundle.files.filter(file => !selected || selected.includes(file.path));
  const identity = createHash("sha256").update(JSON.stringify([input.ownerUserId, input.artifactId, input.versionId, files.map(file => file.path)])).digest("hex");
  const secret = input.secret ?? getAuthConfig().sessionSecret;
  if (!secret) throw new Error("artifact_read_unavailable");
  const sign = (body: string) => createHmac("sha256", secret).update(`aiqsa:artifact-read:v1\0${body}`).digest("base64url");
  const cursor = (index: number, offset: number) => {
    const body = Buffer.from(JSON.stringify({ identity, index, offset })).toString("base64url");
    return `${body}.${sign(body)}`;
  };
  let index = 0;
  let offset = 0;
  const receivedCursor = input.args.cursor;
  if (receivedCursor !== undefined && receivedCursor !== null) {
    if (typeof receivedCursor !== "string" || receivedCursor.length > 1024) return invalid();
    const parts = receivedCursor.split(".");
    const body = parts[0]!;
    const supplied = Buffer.from(parts[1] ?? "");
    const expected = Buffer.from(sign(body));
    if (parts.length !== 2 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) invalid();
    let value: unknown;
    try { value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { invalid(); }
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    const decoded = value as Record<string, unknown>;
    if (decoded.identity !== identity || !Number.isSafeInteger(decoded.index) || Number(decoded.index) < 0 || Number(decoded.index) >= files.length ||
      !Number.isSafeInteger(decoded.offset) || Number(decoded.offset) < 0) invalid();
    index = Number(decoded.index); offset = Number(decoded.offset);
    const text = files[index]!.text;
    if (offset > (text?.length ?? 0) || text && offset > 0 && /[\uDC00-\uDFFF]/u.test(text[offset]!)) invalid();
  }
  const fragments: Fragment[] = [];
  const result = (nextIndex: number, nextOffset: number) => ({ artifact_id: input.artifactId, version_id: input.versionId, files: fragments,
    truncated: nextIndex < files.length, ...(nextIndex < files.length ? { next_cursor: cursor(nextIndex, nextOffset) } : {}) });
  while (index < files.length) {
    const file = files[index]!;
    const bytes = file.text !== undefined ? Buffer.byteLength(file.text) : file.byteSize ?? Buffer.from(file.base64 ?? "", "base64").byteLength;
    const fragment: Fragment = { path: file.path, mimeType: file.mimeType, bytes, offset,
      ...(file.text === undefined ? { binary: true as const } : { text: "" }) };
    fragments.push(fragment);
    if (Buffer.byteLength(JSON.stringify(result(index, offset))) > maxBytes) { fragments.pop(); break; }
    if (file.text === undefined) { index++; offset = 0; continue; }
    let low = offset;
    let high = file.text.length;
    while (low < high) {
      const end = Math.ceil((low + high) / 2);
      fragment.text = file.text.slice(offset, end);
      if (Buffer.byteLength(JSON.stringify(result(index, end))) <= maxBytes) low = end;
      else high = end - 1;
    }
    if (low < file.text.length && low > offset && /[\uDC00-\uDFFF]/u.test(file.text[low]!)) low--;
    fragment.text = file.text.slice(offset, low);
    if (low < file.text.length) { if (low === offset) fragments.pop(); offset = low; break; }
    index++; offset = 0;
  }
  if (!fragments.length && index < files.length) throw new Error("artifact_read_page_too_large");
  return result(index, offset);
}
