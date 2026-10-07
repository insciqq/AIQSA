"use strict";

// A content-free projection of a caught value: the error class, the first
// frame inside the application's own code and a fingerprint that groups
// occurrences of one failure. Message text, stack text and paths outside the
// application never leave this module. It inspects only native errors, reads
// `stack` only through V8's own accessor, and runs on failure paths only.

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { SourceMap } = require("node:module");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { types } = require("node:util");
const zlib = require("node:zlib");

const MAX_SITE_LENGTH = 160;
const MAX_FRAME_LINES = 64;
const FINGERPRINT_FRAMES = 3;
const MAX_MAP_BYTES = 32 * 1024 * 1024;
const MAX_CACHED_FILES = 1024;
const MAX_CACHED_FRAMES = 512;
const MAX_CACHED_MAPS = 16;
const PROJECT_PREFIXES = ["turbopack:///[project]/", "[project]/"];
const nativeStack = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
const sitePath = /^[A-Za-z0-9_.()[\]@+-]+(?:\/[A-Za-z0-9_.()[\]@+-]+)*$/u;
const location = /^(.+):(\d{1,9}):(\d{1,9})$/u;
const caches = { files: new Map(), frames: new Map(), maps: new Map() };
// Every filesystem path here comes from a stack frame at runtime. The ignore
// comments keep Next's file tracing from copying the whole project into the
// standalone output on their account.

function remember(cache, limit, key, value) {
  if (cache.size >= limit) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

function dataValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** The `name` V8 prints in the stack header: the nearest data property. */
function inheritedName(error) {
  for (let prototype = error; prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
    const name = dataValue(prototype, "name");
    if (typeof name === "string") return name;
  }
  return "Error";
}

/** An explicitly assigned name, else the class that constructed the error. */
function errorClass(error) {
  const own = dataValue(error, "name");
  if (typeof own === "string" && identifier.test(own)) return own;
  const constructor = dataValue(Object.getPrototypeOf(error) ?? {}, "constructor");
  const className = typeof constructor === "function" ? dataValue(constructor, "name") : undefined;
  if (typeof className === "string" && identifier.test(className)) return className;
  const inherited = inheritedName(error);
  return identifier.test(inherited) ? inherited : "Error";
}

function stackText(error) {
  const descriptor = Object.getOwnPropertyDescriptor(error, "stack");
  if (!descriptor) return undefined;
  if ("value" in descriptor) return typeof descriptor.value === "string" ? descriptor.value : undefined;
  if (!nativeStack || descriptor.get !== nativeStack) return undefined;
  const stack = Reflect.apply(nativeStack, error, []);
  return typeof stack === "string" ? stack : undefined;
}

/** Frame lines only: after the exact `name: message` header when it matches,
 * else the trailing block of frame-shaped lines, so message lines that
 * imitate frames are never parsed when the header is intact. */
function frameLines(error, stack) {
  const name = inheritedName(error);
  const message = dataValue(error, "message");
  const header = typeof message === "string" && message.length > 0 ? `${name}: ${message}` : name;
  const lines = stack.startsWith(`${header}\n`) ? stack.slice(header.length + 1).split("\n") : null;
  if (lines) return lines.slice(0, MAX_FRAME_LINES);
  const all = stack.split("\n");
  let start = all.length;
  while (start > 0 && /^ {4}at /u.test(all[start - 1])) start -= 1;
  return all.slice(start, start + MAX_FRAME_LINES);
}

function parseFrame(line) {
  if (!line.startsWith("    at ")) return null;
  let body = line.slice(7);
  if (body.startsWith("async ")) body = body.slice(6);
  let functionName = "";
  let place = body;
  const wrapped = body.indexOf(" (/") >= 0 ? body.indexOf(" (/") : body.indexOf(" (file://");
  if (wrapped >= 0 && body.endsWith(")")) {
    functionName = body.slice(0, wrapped);
    place = body.slice(wrapped + 2, -1);
  }
  const match = location.exec(place);
  if (!match) return null;
  let file = match[1];
  if (file.startsWith("file://")) {
    try { file = fileURLToPath(file); } catch { return null; }
  }
  if (!path.isAbsolute(file)) return null;
  return { file, line: Number(match[2]), column: Number(match[3]), functionName: callableName(functionName) };
}

function callableName(value) {
  const name = value.replace(/^new /u, "").replace(/ \[as [^\]]+\]$/u, "");
  const last = name.split(".").at(-1) ?? "";
  return identifier.test(last) && last !== "<anonymous>" ? last : "";
}

function exists(file) {
  const known = caches.files.get(file);
  if (known !== undefined) return known;
  let found = false;
  try { found = fs.statSync(/*turbopackIgnore: true*/ file).isFile(); } catch { found = false; }
  return remember(caches.files, MAX_CACHED_FILES, file, found);
}

function relativeSite(root, file) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  // The line (and a chunk's column) must still fit the site bound.
  if (relative.length === 0 || relative.length > MAX_SITE_LENGTH - 20 || relative.startsWith("../") || path.isAbsolute(relative)) return null;
  if (!sitePath.test(relative) || relative.split("/").some((part) => part === ".." || part === "." || part === "node_modules")) return null;
  return relative;
}

function loadMap(chunk) {
  if (caches.maps.has(chunk)) return caches.maps.get(chunk);
  let map = null;
  for (const [candidate, packed] of [[`${chunk}.map.gz`, true], [`${chunk}.map`, false]]) {
    try {
      if (fs.statSync(/*turbopackIgnore: true*/ candidate).size > MAX_MAP_BYTES) continue;
      const bytes = fs.readFileSync(/*turbopackIgnore: true*/ candidate);
      const text = (packed ? zlib.gunzipSync(bytes, { maxOutputLength: 4 * MAX_MAP_BYTES }) : bytes).toString("utf8");
      map = new SourceMap(JSON.parse(text));
      break;
    } catch { /* A missing or unreadable map leaves the chunk position. */ }
  }
  return remember(caches.maps, MAX_CACHED_MAPS, chunk, map);
}

/** Production maps name sources relative to the chunk, Turbopack dev maps as
 * `file://` URLs or `[project]/` paths; every form must stay inside the project. */
function mappedSource(projectRoot, chunk, source) {
  if (typeof source !== "string") return null;
  const prefix = PROJECT_PREFIXES.find((candidate) => source.startsWith(candidate));
  if (prefix) return relativeSite(projectRoot, path.join(projectRoot, source.slice(prefix.length)));
  if (source.startsWith("file://")) {
    try { return relativeSite(projectRoot, fileURLToPath(source)); } catch { return null; }
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(source) || path.isAbsolute(source)) return null;
  return relativeSite(projectRoot, path.resolve(path.dirname(chunk), source));
}

/** A bundled Next chunk resolves through its build map to the project source;
 * without one the site names the chunk position. */
function chunkSite(root, frame) {
  const marker = frame.file.lastIndexOf(`${path.sep}.next${path.sep}`);
  const projectRoot = frame.file.slice(0, marker);
  const map = loadMap(frame.file);
  const entry = map ? map.findEntry(frame.line - 1, frame.column - 1) : null;
  const source = entry ? mappedSource(projectRoot, frame.file, entry.originalSource) : null;
  if (source && Number.isSafeInteger(entry.originalLine)) {
    const name = typeof entry.name === "string" && identifier.test(entry.name) ? entry.name : "";
    return { path: source, site: `${source}:${entry.originalLine + 1}`, functionName: name, bundled: true };
  }
  const chunk = relativeSite(root, frame.file);
  return chunk ? { path: chunk, site: `${chunk}:${frame.line}:${frame.column}`, functionName: "", bundled: true } : null;
}

/** Bundled frames carry minified names that change with every build, so only
 * a name from the build map counts for them. */
function withName(resolved, frame) {
  if (resolved === null) return null;
  return { ...resolved, functionName: resolved.functionName || (resolved.bundled ? "" : frame.functionName) };
}

function applicationFrame(root, frame) {
  const key = `${root}\u0000${frame.file}:${frame.line}:${frame.column}`;
  const known = caches.frames.get(key);
  if (known !== undefined) return withName(known, frame);
  let resolved = null;
  if (!frame.file.split(path.sep).includes("node_modules") && exists(frame.file)) {
    if (frame.file.includes(`${path.sep}.next${path.sep}`)) {
      resolved = chunkSite(root, frame);
    } else {
      const relative = relativeSite(root, frame.file);
      if (relative) resolved = { path: relative, site: `${relative}:${frame.line}`, functionName: "" };
    }
  }
  return withName(remember(caches.frames, MAX_CACHED_FRAMES, key, resolved), frame);
}

/** The projection of one caught value, or an empty object for nothing. Never throws. */
function describeError(value) {
  try {
    if (value === undefined || value === null) return {};
    if (!types.isNativeError(value)) return { error_class: "non_error" };
    const name = errorClass(value);
    const result = { error_class: name };
    const stack = stackText(value);
    if (!stack) return result;
    const root = process.cwd();
    const frames = [];
    for (const line of frameLines(value, stack)) {
      const frame = parseFrame(line);
      const resolved = frame ? applicationFrame(root, frame) : null;
      if (resolved) frames.push(resolved);
      if (frames.length >= FINGERPRINT_FRAMES) break;
    }
    if (frames.length > 0 && frames[0].site.length <= MAX_SITE_LENGTH) result.error_site = frames[0].site;
    const identity = [name, ...frames.map((frame) => frame.functionName ? `${frame.path}#${frame.functionName}` : frame.path)];
    result.error_fingerprint = createHash("sha256").update(identity.join("\n")).digest("hex").slice(0, 12);
    return result;
  } catch {
    return {};
  }
}

function resetErrorSiteCaches() {
  for (const cache of Object.values(caches)) cache.clear();
}

module.exports = { describeError, resetErrorSiteCaches };
