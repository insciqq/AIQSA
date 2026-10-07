"use strict";

// The standalone output omits server source maps, so error sites of the
// running application would name hashed, minified chunks. After `next build`,
// this packs the maps of chunks that contain application code beside their
// standalone chunks as `<chunk>.js.map.gz`, without embedded sources (the
// image ships the source tree). The observability leaf reads one lazily only
// when it resolves an error site; nothing loads them at startup.

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const zlib = require("node:zlib");

const PROJECT_PREFIXES = ["turbopack:///[project]/", "[project]/"];

/** The project-relative path of one map source, or null for dependencies,
 * framework runtime code and anything outside the project. */
function projectSource(projectRoot, mapDirectory, source) {
  if (typeof source !== "string" || source.length === 0) return null;
  let relative = null;
  const prefix = PROJECT_PREFIXES.find((candidate) => source.startsWith(candidate));
  if (prefix) {
    relative = path.posix.normalize(source.slice(prefix.length));
  } else if (source.startsWith("file://")) {
    try {
      relative = path.relative(projectRoot, fileURLToPath(source)).split(path.sep).join("/");
    } catch {
      relative = null;
    }
  } else if (!/^[a-z][a-z0-9+.-]*:/iu.test(source) && !path.isAbsolute(source)) {
    relative = path.relative(projectRoot, path.resolve(mapDirectory, source)).split(path.sep).join("/");
  }
  if (!relative || relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) return null;
  return relative.split("/").includes("node_modules") ? null : relative;
}

function sourcesOf(map) {
  if (Array.isArray(map.sections)) return map.sections.flatMap((section) => section && section.map ? sourcesOf(section.map) : []);
  return Array.isArray(map.sources) ? map.sources : [];
}

function withoutContent(map) {
  if (Array.isArray(map.sections)) {
    return { ...map, sections: map.sections.map((section) => section && section.map ? { ...section, map: withoutContent(section.map) } : section) };
  }
  const { sourcesContent: _sourcesContent, ...rest } = map;
  return rest;
}

function* mapFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* mapFiles(entryPath);
    else if (entry.isFile() && entry.name.endsWith(".js.map")) yield entryPath;
  }
}

/** Project files no server code reads. Finding one in the standalone output
 * means a dynamic filesystem call made Next trace the whole project; the
 * build prints "Dynamic filesystem access causes tracing of the whole project". */
const UNTRACED_PROJECT_FILES = ["Dockerfile", "README.md"];

function packServerSourceMaps(projectRoot) {
  const serverDirectory = path.join(projectRoot, ".next", "server");
  const standalone = path.join(projectRoot, ".next", "standalone");
  const standaloneServer = path.join(standalone, ".next", "server");
  if (!fs.existsSync(serverDirectory) || !fs.existsSync(standaloneServer)) {
    throw new Error("pack-server-source-maps: run after `next build` with standalone output");
  }
  const traced = UNTRACED_PROJECT_FILES.filter((name) => fs.existsSync(path.join(standalone, name)));
  if (traced.length > 0) {
    throw new Error(`pack-server-source-maps: the standalone output holds ${traced.join(", ")}; ` +
      "a dynamic filesystem call traced the whole project (see the build's tracing warnings)");
  }
  const result = { packed: 0, skipped: 0, bytes: 0 };
  for (const mapPath of mapFiles(serverDirectory)) {
    const relativeMap = path.relative(serverDirectory, mapPath);
    const standaloneChunk = path.join(standaloneServer, relativeMap.slice(0, -".map".length));
    let map;
    try {
      map = fs.existsSync(standaloneChunk) ? JSON.parse(fs.readFileSync(mapPath, "utf8")) : null;
    } catch {
      map = null;
    }
    const mapDirectory = path.dirname(mapPath);
    if (!map || !sourcesOf(map).some((source) => projectSource(projectRoot, mapDirectory, source) !== null)) {
      result.skipped += 1;
      continue;
    }
    const packed = zlib.gzipSync(JSON.stringify(withoutContent(map)), { level: 9 });
    fs.writeFileSync(`${standaloneChunk}.map.gz`, packed);
    result.packed += 1;
    result.bytes += packed.length;
  }
  return result;
}

if (require.main === module) {
  const result = packServerSourceMaps(process.cwd());
  process.stdout.write(`pack-server-source-maps: packed=${result.packed} skipped=${result.skipped} bytes=${result.bytes}\n`);
}

module.exports = { packServerSourceMaps, projectSource };
