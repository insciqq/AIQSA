import { Buffer } from "node:buffer";
import { ARTIFACT_LIMITS, applyArtifactTextEdit, isArtifactTextMime, type NormalizedArtifactOperation } from "@/lib/contracts/artifacts";
import type { ArtifactBundleAsset } from "./bundle";
import { ARTIFACT_ASSET_HINTS, ArtifactToolError } from "./errors";

export const ARTIFACT_ERROR_EXCERPT_CHARACTERS = 200;
const EXCERPT_LEAD_CHARACTERS = 40;
const MIB = 1024 * 1024;

const highSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const lowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

function safeSlice(text: string, start: number, end: number): string {
  let from = Math.max(0, Math.min(start, text.length));
  let to = Math.max(from, Math.min(end, text.length));
  if (from > 0 && from < text.length && lowSurrogate(text.charCodeAt(from)) && highSurrogate(text.charCodeAt(from - 1))) from++;
  if (to < text.length && to > from && highSurrogate(text.charCodeAt(to - 1)) && lowSurrogate(text.charCodeAt(to))) to--;
  return text.slice(from, Math.max(from, to));
}

/**
 * A verbatim slice of at most 200 UTF-16 code units around [start, end): a
 * little leading context, then the failing construct. A construct longer than
 * the bound keeps its beginning, which is what an exact old_string anchors on.
 * Never splits a surrogate pair.
 */
export function artifactErrorExcerpt(text: string, start: number, end = start): string {
  let from = Math.max(0, start - EXCERPT_LEAD_CHARACTERS);
  if (end - from > ARTIFACT_ERROR_EXCERPT_CHARACTERS) from = Math.max(0, start);
  return safeSlice(text, from, from + ARTIFACT_ERROR_EXCERPT_CHARACTERS);
}

type SourceSpan = { startOffset: number; endOffset: number };

/** The start-tag span parse5 recorded for a node parsed with source locations. */
export function artifactSourceSpan(node: object): SourceSpan | undefined {
  const location = (node as { sourceCodeLocation?: (SourceSpan & { startTag?: SourceSpan }) | null }).sourceCodeLocation;
  return location?.startTag ?? location ?? undefined;
}

/** The same tool error with an excerpt of `text` at `span`, when it concerns `path` and has none yet. */
export function withArtifactErrorExcerpt(error: unknown, text: string, span: SourceSpan | undefined, path: string): unknown {
  if (!(error instanceof ArtifactToolError) || error.excerpt !== undefined || error.path !== path || !span) return error;
  return new ArtifactToolError(error.code, { path, hint: error.hint, excerpt: artifactErrorExcerpt(text, span.startOffset, span.endOffset) });
}

/** A verbatim slice of at most 200 UTF-16 code units ending right before `index`. */
export function artifactExcerptBefore(text: string, index: number): string {
  return safeSlice(text, index - ARTIFACT_ERROR_EXCERPT_CHARACTERS, index);
}

/** Exact UTF-8 bytes as text; a BOM stays in the text so the bytes round-trip. */
export function artifactTextFromBytes(bytes: Uint8Array, path: string): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch {
    throw new ArtifactToolError("artifact_text_encoding_invalid", { path,
      hint: "The referenced text file is not valid UTF-8. Convert it to UTF-8 in Workspace and reference the converted file." });
  }
}

/**
 * Decode every by-reference text file and apply the operation's deferred
 * edits to it. The edited text keeps the referenced-file bound (24 MiB), not
 * the bound for text written in the call. Returns the bytes to store, the
 * decoded texts (for resource discovery) and the paths whose bytes changed.
 */
export function materializeArtifactReferences(operation: NormalizedArtifactOperation, assets: readonly ArtifactBundleAsset[]): Readonly<{
  assets: ArtifactBundleAsset[];
  texts: ReadonlyMap<string, string>;
  edited: ReadonlySet<string>;
}> {
  const texts = new Map<string, string>();
  for (const file of operation.files) {
    if (!file.assetRef || !isArtifactTextMime(file.mimeType)) continue;
    const asset = assets.find(candidate => candidate.path === file.path);
    if (!asset) throw new Error("artifact_asset_unavailable");
    texts.set(file.path, artifactTextFromBytes(asset.bytes, file.path));
  }
  const edited = new Set<string>();
  for (const edit of operation.referenceEdits ?? []) {
    const text = texts.get(edit.path);
    if (text === undefined) throw new ArtifactToolError("artifact_edit_path_invalid", { path: edit.path,
      hint: `Edit ${edit.editIndex + 1}: edit a text file supplied by asset_ref in this call or an existing text file of the accepted artifact.` });
    texts.set(edit.path, applyArtifactTextEdit(text, edit, edit.path, edit.editIndex));
    edited.add(edit.path);
  }
  let totalBytes = operation.totalBytes;
  const result = assets.map(asset => {
    const text = edited.has(asset.path) ? texts.get(asset.path) : undefined;
    if (text === undefined) return asset;
    // Replacement strings come from the call: keep the stored text well formed.
    if (/[\uD800-\uDFFF]/u.test(text)) throw new ArtifactToolError("artifact_text_invalid", { path: asset.path,
      hint: "The edits leave an unpaired UTF-16 surrogate in this file; use complete characters in new_string." });
    const bytes = Buffer.from(text, "utf8");
    if (!bytes.byteLength) throw new ArtifactToolError("artifact_edit_invalid", { path: asset.path,
      hint: "Edits cannot leave a referenced file empty; omit the file instead." });
    if (bytes.byteLength > ARTIFACT_LIMITS.maxAssetBytes) throw new ArtifactToolError("artifact_text_limit_exceeded", { path: asset.path,
      hint: `A referenced text file may be at most ${ARTIFACT_LIMITS.maxAssetBytes / MIB} MiB after edits.` });
    return { ...asset, bytes };
  });
  for (const asset of result) totalBytes += asset.bytes.byteLength;
  if (totalBytes > ARTIFACT_LIMITS.maxBundleBytes) throw new ArtifactToolError("artifact_bundle_limit_exceeded", {
    hint: ARTIFACT_ASSET_HINTS.artifact_bundle_limit_exceeded });
  return { assets: result, texts, edited };
}
