import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { expect, type APIRequestContext, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { readZipArchive, type ZipReadLimits } from "../../../lib/server/artifacts/zipReader";

/**
 * Shared steps and oracles for the opt-in file-to-artifact specs
 * (artifact-files-paid.spec.ts, artifact-files-adaptive.spec.ts). Everything
 * here returns facts for the caller to assert and print: booleans, counts,
 * sizes and stable codes, never file content, prompts, answers or ids.
 */

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The sandboxed artifact frame of every viewer (ArtifactFrameV2). */
export const ARTIFACT_FRAME = "iframe.v2-artifact-frame";
export const artifactFrame = (page: Page): FrameLocator => page.frameLocator(ARTIFACT_FRAME);
/**
 * The private viewer's runtime-error or blocked-resource banner and its load
 * failure (PrivateArtifactView.tsx); the public view shows neither.
 */
export const artifactErrorBanner = (page: Page): Locator =>
  page.locator('.v2-artifact-banner[role="alert"], .v2-artifact-empty[role="alert"]');

const MESSAGE_CODE = /^[a-z][a-z0-9_]{0,95}$/u;
/** A server error code, or a neutral placeholder: response bodies are never echoed. */
export const safeCode = (value: unknown): string => typeof value === "string" && MESSAGE_CODE.test(value) ? value : "unknown";

// ------------------------------------------------------------------ Pixels ---

export type DecodedImage = Readonly<{ width: number; height: number; channels: number; pixels: Uint8Array }>;

/** Non-interlaced 8-bit PNG (gray, gray+alpha, RGB, RGBA), as browsers write screenshots. */
export function decodePng(png: Buffer): DecodedImage {
  if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error("png_invalid");
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const data: Buffer[] = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels || bitDepth !== 8 || interlace !== 0 || width < 1 || height < 1) throw new Error("png_unsupported");
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("png_truncated");
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[out + x - channels]! : 0;
      const up = y > 0 ? pixels[out - stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[out - stride + x - channels]! : 0;
      let predictor: number;
      switch (filter) {
        case 0: predictor = 0; break;
        case 1: predictor = left; break;
        case 2: predictor = up; break;
        case 3: predictor = (left + up) >> 1; break;
        case 4: {
          const estimate = left + up - upLeft;
          const toLeft = Math.abs(estimate - left);
          const toUp = Math.abs(estimate - up);
          const toUpLeft = Math.abs(estimate - upLeft);
          predictor = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
          break;
        }
        default: throw new Error("png_filter_invalid");
      }
      pixels[out + x] = (raw[line + x]! + predictor) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function luminance(image: DecodedImage, index: number): number {
  const at = index * image.channels;
  if (image.channels < 3) return image.pixels[at]!;
  return 0.299 * image.pixels[at]! + 0.587 * image.pixels[at + 1]! + 0.114 * image.pixels[at + 2]!;
}

/** Standard deviation of luminance (0–255): 0 for a uniform region. */
export function luminanceStdDev(image: DecodedImage): number {
  const count = image.width * image.height;
  let sum = 0;
  let squares = 0;
  for (let index = 0; index < count; index++) {
    const value = luminance(image, index);
    sum += value;
    squares += value * value;
  }
  const mean = sum / count;
  return Math.sqrt(Math.max(0, squares / count - mean * mean));
}

/** Share of pixels whose luminance moved by more than `delta` between two captures of one region. */
export function changedFraction(before: DecodedImage, after: DecodedImage, delta = 16): number {
  if (before.width !== after.width || before.height !== after.height) return 1;
  const count = before.width * before.height;
  let changed = 0;
  for (let index = 0; index < count; index++) {
    if (Math.abs(luminance(before, index) - luminance(after, index)) > delta) changed++;
  }
  return changed / count;
}

/** A capture is non-uniform above this luminance spread; a blank or single-colour region stays near 0. */
export const NON_UNIFORM_STDDEV = 6;

export type Box = Readonly<{ x: number; y: number; width: number; height: number }>;

/**
 * A viewport clip of `box`, never an element screenshot: Chromium drops touch
 * emulation after an element screenshot taller than the viewport.
 */
export async function clipCapture(page: Page, box: Box): Promise<DecodedImage & { png: Buffer }> {
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const left = Math.max(0, Math.floor(box.x));
  const top = Math.max(0, Math.floor(box.y));
  const right = Math.min(viewport.width, Math.ceil(box.x + box.width));
  const bottom = Math.min(viewport.height, Math.ceil(box.y + box.height));
  if (right - left < 2 || bottom - top < 2) throw new Error("artifact_capture_outside_viewport");
  const png = await page.screenshot({ clip: { x: left, y: top, width: right - left, height: bottom - top } });
  return { ...decodePng(png), png };
}

/** The largest laid-out canvas of the artifact and its box in page coordinates; null without one. */
export async function largestCanvas(page: Page): Promise<{ canvas: Locator; box: Box } | null> {
  const canvases = artifactFrame(page).locator("canvas");
  let best: { canvas: Locator; box: Box } | null = null;
  const count = await canvases.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 16); index++) {
    const box = await canvases.nth(index).boundingBox().catch(() => null);
    if (box && box.width > 0 && box.height > 0 && (!best || box.width * box.height > best.box.width * best.box.height)) {
      best = { canvas: canvases.nth(index), box };
    }
  }
  return best;
}

export const largestCanvasBox = async (page: Page): Promise<Box | null> => (await largestCanvas(page))?.box ?? null;

/**
 * The artifact's first button a pointer can reach: laid out, inside the
 * frame's viewport and on top at its centre (not under the scene's overlay).
 */
export async function firstReachableButton(page: Page): Promise<Locator | null> {
  const index = await artifactFrame(page).locator("body").evaluate((body) => {
    const buttons = Array.from(body.ownerDocument.querySelectorAll("button"));
    return buttons.findIndex((button) => {
      const rect = button.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || button.disabled) return false;
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
      const top = body.ownerDocument.elementFromPoint(x, y);
      return top !== null && (top === button || button.contains(top));
    });
  }).catch(() => -1);
  return index >= 0 ? artifactFrame(page).locator("button").nth(index) : null;
}

/** The artifact frame's own box in page coordinates. */
export async function frameBox(page: Page): Promise<Box> {
  const box = await page.locator(ARTIFACT_FRAME).boundingBox();
  if (!box || box.width < 2 || box.height < 2) throw new Error("artifact_frame_not_laid_out");
  return box;
}

/**
 * Polls captures of the region `region()` returns until one is non-uniform;
 * resolves with the elapsed time from `since`, or null after `timeoutMs`.
 */
export async function firstNonUniform(page: Page, region: () => Promise<Box | null>, since: number, timeoutMs: number,
  intervalMs = 400): Promise<{ ms: number; stddev: number } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const box = await region().catch(() => null);
    if (box) {
      const capture = await clipCapture(page, box).catch(() => null);
      if (capture) {
        const stddev = luminanceStdDev(capture);
        if (stddev > NON_UNIFORM_STDDEV) return { ms: Date.now() - since, stddev: Number(stddev.toFixed(2)) };
      }
    }
    if (Date.now() > deadline) return null;
    await page.waitForTimeout(intervalMs);
  }
}

// -------------------------------------------------------------- ZIP files ---

/** Bounds for reading the product's own exports, wider than an upload's. */
const EXPORT_ZIP_LIMITS: ZipReadLimits = Object.freeze({
  maxEntries: 2_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 160 * 1024 * 1024,
  maxCompressionRatio: 10_000,
  ratioFloorBytes: 1024 * 1024
});

/**
 * Every file of a ZIP by path. The reader strips a single top-level folder;
 * by default it is restored, so an export reads as written. Folders and
 * macOS metadata (`__MACOSX/`, `.DS_Store`, `._*`) are skipped.
 */
export async function zipFiles(bytes: Uint8Array, options: Readonly<{ stripRoot?: boolean }> = {}): Promise<Map<string, Buffer>> {
  const archive = await readZipArchive(bytes, EXPORT_ZIP_LIMITS);
  return new Map(archive.entries.map((entry) =>
    [archive.strippedRoot === null || options.stripRoot ? entry.path : `${archive.strippedRoot}/${entry.path}`, entry.bytes]));
}

/** The owner's ZIP export of one version (`?download=zip`): source files, HTML re-serialized by the exporter. */
export async function exportedArtifactFiles(request: APIRequestContext, artifactId: string, versionId: string):
  Promise<{ files: Map<string, Buffer>; zip: Buffer }> {
  const response = await request.get(`/api/artifacts/${artifactId}/versions/${versionId}/content?download=zip`, { timeout: 300_000 });
  if (response.status() !== 200) {
    const code = safeCode((await response.json().catch(() => null) as { error?: unknown } | null)?.error);
    throw new Error(`afc_export_refused_${response.status()}_${code}`);
  }
  const zip = await response.body();
  return { files: await zipFiles(zip), zip };
}

/** Whether two file maps hold exactly the same paths and bytes. */
export function sameFiles(left: ReadonlyMap<string, Buffer>, right: ReadonlyMap<string, Buffer>): boolean {
  if (left.size !== right.size) return false;
  for (const [path, bytes] of left) if (!right.get(path)?.equals(bytes)) return false;
  return true;
}

// ------------------------------------------------------------ Text facts ---

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Visible text of an HTML document: no scripts, styles, comments or tags; entities decoded; spaces collapsed. */
export function htmlVisibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (whole, name: string) => {
      if (name[0] === "#") {
        const code = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
        return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/\s+/gu, " ")
    .trim();
}

/** Strict UTF-8 text of a file, or null for binary content. */
export function utf8Text(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

/** Raw bytes plus every inflatable stream of a PDF, as latin1, for structure and marker searches. */
function pdfSearchText(bytes: Buffer): string {
  const parts = [bytes.toString("latin1")];
  const source = parts[0]!;
  const pattern = /stream\r?\n/gu;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const start = match.index + match[0].length;
    const end = source.indexOf("endstream", start);
    if (end < 0) break;
    try { parts.push(inflateSync(bytes.subarray(start, end)).toString("latin1")); } catch { /* Not a Flate stream. */ }
    pattern.lastIndex = end;
  }
  return parts.join("\n");
}

/**
 * Page objects counted in the file and its object streams (`/Type /Page`, not
 * `/Pages`). Page text is glyph-encoded in most producers, so content checks
 * of a PDF are limited to this count and to markers in plain or UTF-16 form.
 */
export function pdfPageCount(bytes: Buffer): number {
  return pdfSearchText(bytes).match(/\/Type\s*\/Page(?![a-z])/giu)?.length ?? 0;
}

export const isPdf = (bytes: Buffer): boolean => bytes.subarray(0, 5).toString("latin1") === "%PDF-";

/** Whether `marker` occurs in the bytes as UTF-8, UTF-16 (either order) or inside an inflated PDF stream. */
export function containsMarker(bytes: Buffer, marker: string): boolean {
  if (bytes.includes(Buffer.from(marker, "utf8")) || bytes.includes(Buffer.from(marker, "utf16le"))) return true;
  if (bytes.includes(Buffer.from(marker, "utf16le").swap16())) return true;
  return isPdf(bytes) && pdfSearchText(bytes).includes(marker);
}

// ------------------------------------------------------- Data oracles ---

const near = (value: number, expected: number) => Math.abs(value - expected) <= 0.01;

type Pair = Readonly<{ label: string; value: number }>;

function regionKey(value: string, regions: readonly string[]): string | null {
  const trimmed = value.trim().toLowerCase();
  return regions.find((region) => region.toLowerCase() === trimmed) ?? null;
}

/** Region/number pairs of a JSON value: keyed numbers, records naming a region, and parallel label/value arrays. */
function jsonPairs(value: unknown, regions: readonly string[], pairs: Pair[], sums: Map<string, number>): void {
  if (Array.isArray(value)) {
    for (const item of value) jsonPairs(item, regions, pairs, sums);
    return;
  }
  if (!value || typeof value !== "object") return;
  const entries = Object.entries(value as Record<string, unknown>);
  const named = entries.map(([, item]) => typeof item === "string" ? regionKey(item, regions) : null).find(Boolean) ?? null;
  for (const [key, item] of entries) {
    const keyed = regionKey(key, regions);
    if (keyed && typeof item === "number") pairs.push({ label: keyed, value: item });
    if (named && typeof item === "number") {
      pairs.push({ label: named, value: item });
      sums.set(`${named}\u0000${key}`, (sums.get(`${named}\u0000${key}`) ?? 0) + item);
    }
  }
  const labels = entries.map(([, item]) => item).filter((item): item is unknown[] => Array.isArray(item) &&
    item.length > 0 && item.every((label) => typeof label === "string" && regionKey(label, regions) !== null));
  const numbers = entries.map(([, item]) => item).filter((item): item is unknown[] => Array.isArray(item) &&
    item.length > 0 && item.every((number) => typeof number === "number"));
  for (const names of labels) {
    for (const values of numbers) {
      if (values.length !== names.length) continue;
      names.forEach((name, index) => pairs.push({ label: regionKey(name as string, regions)!, value: values[index] as number }));
    }
  }
  for (const [, item] of entries) jsonPairs(item, regions, pairs, sums);
}

/** Numbers written in a text, with thousands commas removed ("49,109.75" reads as 49109.75). */
function textNumbers(text: string): number[] {
  return (text.replace(/(\d),(?=\d{3}(?!\d))/gu, "$1").match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number).filter(Number.isFinite);
}

export type RegionTotalsEvidence = Readonly<{ found: number; regions: number; source: "json" | "text" | "mixed" | null }>;

/**
 * Whether the files reproduce each region's total within 0.01: from JSON
 * (keyed totals, records, label/value arrays, or per-region sums of record
 * rows), else from any text file that names the region and writes the total.
 */
export function regionTotalsEvidence(files: ReadonlyMap<string, Buffer>, expected: Readonly<Record<string, number>>): RegionTotalsEvidence {
  const regions = Object.keys(expected);
  const byJson = new Set<string>();
  const byText = new Set<string>();
  for (const bytes of files.values()) {
    const text = utf8Text(bytes);
    if (text === null) continue;
    let parsed: unknown;
    let isJson = false;
    try { parsed = JSON.parse(text); isJson = true; } catch { /* Not a JSON document. */ }
    if (isJson) {
      const pairs: Pair[] = [];
      const sums = new Map<string, number>();
      jsonPairs(parsed, regions, pairs, sums);
      for (const region of regions) {
        if (pairs.some((pair) => pair.label === region && near(pair.value, expected[region]!)) ||
          [...sums].some(([key, sum]) => key.startsWith(`${region}\u0000`) && near(sum, expected[region]!))) byJson.add(region);
      }
    }
    const numbers = textNumbers(text);
    for (const region of regions) {
      if (text.includes(region) && numbers.some((number) => near(number, expected[region]!))) byText.add(region);
    }
  }
  const found = regions.filter((region) => byJson.has(region) || byText.has(region)).length;
  const source = found === 0 ? null : regions.every((region) => byJson.has(region)) ? "json"
    : regions.some((region) => byJson.has(region)) ? "mixed" : "text";
  return { found, regions: regions.length, source };
}

// ------------------------------------------------- No-model API fixtures ---

export type UploadFile = Readonly<{ fileName: string; mimeType: string; bytes: Buffer }>;

/**
 * The composer's direct upload (`POST /api/uploads`); `workspace` marks the
 * Workspace scope that admits formats outside the attachment registry.
 * The attachment is not yet bound to a chat.
 */
export async function uploadAttachment(request: APIRequestContext, file: UploadFile, options: Readonly<{ workspace?: boolean }> = {}):
  Promise<{ id: string; status: string }> {
  const response = await request.post("/api/uploads", { timeout: 300_000, multipart: {
    file: { name: file.fileName, mimeType: file.mimeType, buffer: file.bytes },
    ...(options.workspace ? { scope: "workspace" } : {})
  } });
  const body = await response.json().catch(() => null) as { attachment?: { id?: unknown; status?: unknown }; error?: unknown } | null;
  if (!response.ok() || typeof body?.attachment?.id !== "string") {
    throw new Error(`afc_upload_refused_${response.status()}_${safeCode(body?.error)}`);
  }
  return { id: body.attachment.id, status: String(body.attachment.status) };
}

export type ArtifactFileRef = Readonly<{ path: string; mimeType: string; assetRef: string; unpack?: true }>;

/**
 * Creates an artifact by reference through the owner's API, without a chat:
 * an unbound upload is referenceable only without `sourceChatId`. `unpack`
 * asks the server to unpack a website ZIP at the bundle root.
 */
export async function createArtifactFromUploads(request: APIRequestContext, input: Readonly<{
  title: string; kind?: "html" | "game"; entrypoint: string; files: readonly ArtifactFileRef[];
}>): Promise<{ artifactId: string; versionId: string; versionNumber: number }> {
  const response = await request.post("/api/artifacts", { timeout: 300_000, data: { operation: {
    intent: "create", kind: input.kind ?? "html", title: input.title, entrypoint: input.entrypoint, files: input.files
  } } });
  const body = await response.json().catch(() => null) as { version?: { id?: unknown; artifactId?: unknown; versionNumber?: unknown }; error?: unknown } | null;
  if (response.status() !== 201 || typeof body?.version?.id !== "string" || typeof body.version.artifactId !== "string") {
    throw new Error(`afc_artifact_create_refused_${response.status()}_${safeCode(body?.error)}`);
  }
  return { artifactId: body.version.artifactId, versionId: body.version.id, versionNumber: Number(body.version.versionNumber) };
}

export type Publication = Readonly<{ id: string; publicPath: string; revision: number }>;

/** A single-version public link, as the Share dialog's default creates it. */
export async function publishVersion(request: APIRequestContext, artifactId: string, versionId: string): Promise<Publication> {
  const response = await request.post(`/api/artifacts/${artifactId}/publish`, { data: { versionId } });
  const body = await response.json().catch(() => null) as { publication?: Partial<Publication>; error?: unknown } | null;
  if (response.status() !== 201 || typeof body?.publication?.publicPath !== "string" || typeof body.publication.id !== "string") {
    throw new Error(`afc_publish_refused_${response.status()}_${safeCode(body?.error)}`);
  }
  // A boolean, so a failure never prints the bearer path.
  expect(/^\/a\/[A-Za-z0-9_-]{32,128}$/u.test(body.publication.publicPath), "a publication returns a bounded bearer path").toBe(true);
  return { id: body.publication.id, publicPath: body.publication.publicPath, revision: Number(body.publication.revision ?? 1) };
}

/** The anonymous content route of a public page path. */
export const publicContentPath = (publicPath: string): string => publicPath.replace(/^\/a\//u, "/api/artifact-public/");

/**
 * Removes an owned artifact (its publications go with it); a missing one is
 * fine. An unsent upload has no delete route: the stand's retention owns it.
 */
export async function removeArtifact(request: APIRequestContext, artifactId: string): Promise<void> {
  const response = await request.delete(`/api/artifacts/${artifactId}`, { timeout: 60_000 }).catch(() => null);
  if (response && !response.ok() && response.status() !== 404) throw new Error(`afc_artifact_cleanup_${response.status()}`);
}

/**
 * The operator's private large page, never part of the repository: the exact
 * path in AIQSA_AFC_LARGE_HTML, or the single `.html` file the stand harness
 * placed in AIQSA_AFC_PRIVATE_DIR. Absent means the case is skipped.
 */
export function privateLargeHtmlPath(): string | null {
  const explicit = process.env.AIQSA_AFC_LARGE_HTML?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  const directory = process.env.AIQSA_AFC_PRIVATE_DIR?.trim();
  if (!directory || !existsSync(directory)) return null;
  const pages = readdirSync(directory).filter(name => name.toLowerCase().endsWith(".html"));
  return pages.length === 1 ? join(directory, pages[0]!) : null;
}
