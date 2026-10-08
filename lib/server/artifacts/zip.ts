import { deflateRawSync } from "node:zlib";
import { posix } from "node:path";
import type { DefaultTreeAdapterMap, Token } from "parse5";
import { bundleFileBytes, localResourcePath, type ArtifactBundle, type ArtifactBundleFile } from "./bundle";
import { parseArtifactCss } from "./css";
import { parseArtifactHtml } from "./htmlParse";
import { crc32 } from "../../domain/crc32";

export { crc32 } from "../../domain/crc32";

type Element = DefaultTreeAdapterMap["element"];
type Splice = Readonly<{ start: number; end: number; text: string }>;
/** Elements whose references the export points at vendored copies; integrity and crossorigin would block those copies offline. */
const RESOURCE_ELEMENTS = new Set(["script", "link", "img", "image"]);
/** The JavaScript MIME type essences of the HTML standard: a script of any other type is a data block. */
const JAVASCRIPT_TYPES = new Set(["application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
  "text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2", "text/javascript1.3",
  "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript", "text/x-ecmascript", "text/x-javascript"]);

/** Whether a browser runs this script element, and so would load its `src`; HTML's type-string rules. */
function scriptRuns(node: Element): boolean {
  const attribute = (name: string) => node.attrs.find(attr => attr.name === name)?.value;
  const type = attribute("type");
  const language = attribute("language");
  if (type === "" || type === undefined && !language) return true;
  const value = (type === undefined ? `text/${language}` : type.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, "")).toLowerCase();
  return value === "module" || JAVASCRIPT_TYPES.has(value);
}

/** The source with each splice applied; splices are disjoint source ranges. */
function applySplices(source: string, splices: Splice[]): string {
  let text = "", cursor = 0;
  for (const splice of [...splices].sort((left, right) => left.start - right.start)) {
    if (splice.start < cursor) continue;
    text += source.slice(cursor, splice.start) + splice.text;
    cursor = splice.end;
  }
  return text + source.slice(cursor);
}

/**
 * Exports every file as stored, except where an offline copy needs a change: a vendored
 * stylesheet's url() references and, in HTML and SVG markup, the attributes and inline text
 * named below, spliced into the source. Nothing else is parsed into a new serialization, so a
 * file without such references, such as an SVG from an editor, keeps its exact bytes.
 */
export function artifactZip(bundle: ArtifactBundle): Buffer {
  const resources = new Map(bundle.files.filter(file => file.vendor).map(file => [file.vendor!.sourceUrl, file]));
  const byPath = new Map(bundle.files.map(file => [file.path, file]));
  /** The file a script src names, by the renderer's rules: a local path, else a vendored URL. */
  function scriptFile(value: string, from: ArtifactBundleFile): ArtifactBundleFile | undefined {
    const path = localResourcePath(value, from.path);
    const local = path ? byPath.get(path) : undefined;
    if (local) return local;
    try { return resources.get(new URL(value).href); } catch { return undefined; }
  }
  /** The vendored copy's path relative to `from`; null for a URL the version did not vendor. */
  function vendoredPath(value: string, from: ArtifactBundleFile): string | null {
    const base = from.vendor?.resolvedUrl ?? from.vendor?.sourceUrl;
    let url: string;
    try { url = new URL(value, base).href; } catch { return null; }
    const resource = resources.get(url);
    return resource ? posix.relative(posix.dirname(from.path), resource.path) : null;
  }
  function exportedMarkup(file: ArtifactBundleFile): string {
    const source = file.text!;
    const splices: Splice[] = [];
    const remove = (span: Token.Location | undefined) => { if (span) splices.push({ start: span.startOffset, end: span.endOffset, text: "" }); };
    function visit(node: DefaultTreeAdapterMap["node"]): void {
      if ("tagName" in node) {
        // Elements the parser implied have no source to change.
        const location = node.sourceCodeLocation;
        const tag = location?.startTag;
        if (location && tag && RESOURCE_ELEMENTS.has(node.tagName)) {
          const span = (name: string) => location.attrs?.[name];
          const src = node.attrs.find(attr => attr.name === "src");
          const target = node.tagName === "script" && src && !scriptRuns(node) ? scriptFile(src.value, file) : undefined;
          const end = location.endTag;
          if (target?.text !== undefined && end && span("src")) {
            // A browser never loads the src of a script it does not run (the pdf.js worker
            // pattern: type="text/js-worker"), so the export carries its text inline, as pages do.
            remove(span("src"));
            splices.push({ start: tag.endOffset, end: end.startOffset, text: target.text.replace(/<\/script/giu, "<\\/script") });
          } else {
            for (const attr of node.attrs) {
              const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
              const attribute = span(name);
              const local = ["src", "href"].includes(attr.name) && /^https:\/\//iu.test(attr.value) ? vendoredPath(attr.value, file) : null;
              if (attribute && local !== null) splices.push({ start: attribute.startOffset, end: attribute.endOffset, text: `${name}="${local}"` });
            }
          }
          remove(span("integrity")); remove(span("crossorigin"));
        }
      }
      if ("childNodes" in node) node.childNodes.forEach(visit);
      if ("content" in node) visit(node.content);
    }
    visit(parseArtifactHtml(source, { sourceCodeLocationInfo: true }));
    return splices.length ? applySplices(source, splices) : source;
  }
  function exportedText(file: ArtifactBundleFile): string {
    if (file.mimeType === "text/css" && file.vendor) {
      const parsed = parseArtifactCss(file.text!, file.path);
      for (const reference of parsed.references) {
        if (reference.value.startsWith("#") || reference.value.startsWith("data:") || !URL.canParse(reference.value, file.vendor.resolvedUrl ?? file.vendor.sourceUrl)) continue;
        // Vendoring downloaded every resource a stylesheet names.
        const local = vendoredPath(reference.value, file);
        if (local === null) throw new Error("artifact_bundle_file_invalid");
        reference.replace(local);
      }
      return parsed.text();
    }
    return ["text/html", "image/svg+xml"].includes(file.mimeType) ? exportedMarkup(file) : file.text!;
  }
  return writeZip(bundle.files.map((file) => ({
    path: file.path,
    bytes: file.text !== undefined ? Buffer.from(exportedText(file), "utf8") : bundleFileBytes(file)
  })));
}

/** Callers bound and authorize entries before materializing their bytes. */
export function writeZip(files: readonly { path: string; bytes: Uint8Array; executable?: boolean }[]): Buffer {
  if (files.length > 65_534) throw new Error("zip_entries_exceeded");
  const entries: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    if (name.length > 65_535) throw new Error("zip_path_too_long");
    const bytes = file.bytes;
    const compressed = deflateRawSync(bytes);
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(33, 12); // 1980-01-01, stable archive metadata.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix, ZIP 2.0.
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(((0o100000 | (file.executable ? 0o755 : 0o644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    entries.push(local, name, compressed);
    directory.push(central, name);
    offset += local.length + name.length + compressed.length;
    if (offset >= 0xffffffff) throw new Error("zip_size_exceeded");
  }
  const centralBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, centralBytes, end]);
}
