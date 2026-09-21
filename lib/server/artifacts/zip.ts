import { deflateRawSync } from "node:zlib";
import { posix } from "node:path";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import { bundleFileBytes, type ArtifactBundle, type ArtifactBundleFile } from "./bundle";
import { parseArtifactCss } from "./css";

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Bounded, normalized bundle paths only; no filesystem or archive extraction. */
export function artifactZip(bundle: ArtifactBundle): Buffer {
  const resources = new Map(bundle.files.filter(file => file.vendor).map(file => [file.vendor!.sourceUrl, file]));
  function relative(value: string, from: ArtifactBundleFile): string {
    if (value.startsWith("#") || value.startsWith("data:")) return value;
    const base = from.vendor?.resolvedUrl ?? from.vendor?.sourceUrl;
    let url: string;
    try { url = new URL(value, base).href; } catch { return value; }
    const resource = resources.get(url);
    if (!resource) throw new Error("artifact_bundle_file_invalid");
    return posix.relative(posix.dirname(from.path), resource.path);
  }
  function exportedText(file: ArtifactBundleFile): string {
    if (file.mimeType === "text/css" && file.vendor) {
      const parsed = parseArtifactCss(file.text!, file.path);
      for (const reference of parsed.references) reference.replace(relative(reference.value, file));
      return parsed.text();
    }
    if (!["text/html", "image/svg+xml"].includes(file.mimeType)) return file.text!;
    const document = parse(file.text!);
    function visit(node: DefaultTreeAdapterMap["node"]): void {
      if ("tagName" in node) {
        if (["script", "link", "img", "image"].includes(node.tagName)) {
          for (const attr of node.attrs) if (["src", "href"].includes(attr.name) && /^https:\/\//iu.test(attr.value)) attr.value = relative(attr.value, file);
          node.attrs = node.attrs.filter(attr => !["integrity", "crossorigin"].includes(attr.name));
        }
      }
      if ("childNodes" in node) node.childNodes.forEach(visit);
      if ("content" in node) visit(node.content);
    }
    visit(document);
    if (file.mimeType === "image/svg+xml") {
      const find = (node: DefaultTreeAdapterMap["node"]): DefaultTreeAdapterMap["element"] | undefined =>
        "tagName" in node && node.tagName === "svg" ? node : "childNodes" in node ? node.childNodes.map(find).find(Boolean) : undefined;
      const svg = find(document);
      if (svg) return serialize({ nodeName: "#document-fragment", childNodes: [svg] });
    }
    return serialize(document);
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
