// @vitest-environment node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

type Packer = {
  packServerSourceMaps(projectRoot: string): { packed: number; skipped: number; bytes: number };
  projectSource(projectRoot: string, mapDirectory: string, source: string): string | null;
};

const require = createRequire(import.meta.url);
const { packServerSourceMaps, projectSource } = require("./pack-server-source-maps.cjs") as Packer;

const directories: string[] = [];

function project() {
  const root = mkdtempSync(path.join(tmpdir(), "aiqsa-source-maps-"));
  directories.push(root);
  const chunks = path.join(root, ".next", "server", "chunks");
  const standalone = path.join(root, ".next", "standalone", ".next", "server", "chunks");
  mkdirSync(chunks, { recursive: true });
  mkdirSync(standalone, { recursive: true });
  const chunk = (name: string, map: unknown, shipped = true) => {
    writeFileSync(path.join(chunks, `${name}.js`), "x");
    writeFileSync(path.join(chunks, `${name}.js.map`), JSON.stringify(map));
    if (shipped) writeFileSync(path.join(standalone, `${name}.js`), "x");
  };
  return { root, standalone, chunk };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("server source map packing", () => {
  it("ships gzip maps without embedded sources only beside standalone chunks with application code", () => {
    const { root, standalone, chunk } = project();
    chunk("app", { version: 3, sources: ["../../../lib/server/x.ts", "../../../node_modules/pkg/index.js"],
      sourcesContent: ["private source", "dependency"], names: [], mappings: "AAAA" });
    chunk("sections", { version: 3, sections: [{ offset: { line: 0, column: 0 }, map: {
      version: 3, sources: ["turbopack:///[project]/app/page.tsx"], sourcesContent: ["private page"], names: [], mappings: "AAAA"
    } }] });
    chunk("dependency", { version: 3, sources: ["../../../node_modules/pkg/index.js", "turbopack:///[turbopack]/runtime.ts"], names: [], mappings: "AAAA" });
    chunk("unshipped", { version: 3, sources: ["../../../lib/server/y.ts"], names: [], mappings: "AAAA" }, false);

    expect(packServerSourceMaps(root)).toEqual(expect.objectContaining({ packed: 2, skipped: 2 }));
    const read = (name: string) => JSON.parse(gunzipSync(readFileSync(path.join(standalone, `${name}.js.map.gz`))).toString("utf8"));
    expect(read("app")).toEqual({ version: 3, sources: ["../../../lib/server/x.ts", "../../../node_modules/pkg/index.js"], names: [], mappings: "AAAA" });
    expect(JSON.stringify(read("sections"))).not.toContain("private page");
    expect(existsSync(path.join(standalone, "dependency.js.map.gz"))).toBe(false);
    expect(existsSync(path.join(standalone, "unshipped.js.map.gz"))).toBe(false);
  });

  it("names project sources and rejects dependencies, runtime code and paths outside the project", () => {
    const root = "/build/app";
    const chunks = "/build/app/.next/server/chunks";
    expect(projectSource(root, chunks, "../../../lib/contracts/chats.ts")).toBe("lib/contracts/chats.ts");
    expect(projectSource(root, chunks, "turbopack:///[project]/lib/x.ts")).toBe("lib/x.ts");
    expect(projectSource(root, chunks, "[project]/app/api/route.ts")).toBe("app/api/route.ts");
    expect(projectSource(root, chunks, "../../../node_modules/next/dist/server.js")).toBeNull();
    expect(projectSource(root, chunks, "turbopack:///[turbopack]/runtime.ts")).toBeNull();
    expect(projectSource(root, chunks, "../../../../etc/passwd")).toBeNull();
    expect(projectSource(root, chunks, "/home/user/private.ts")).toBeNull();
    expect(projectSource(root, chunks, "file:///home/user/private.ts")).toBeNull();
    expect(projectSource(root, chunks, "file:///build/app/app/api/route.ts")).toBe("app/api/route.ts");
    expect(projectSource(root, chunks, "file:///build/app/node_modules/next/dist/x.js")).toBeNull();
  });

  it("fails the build when tracing copied the whole project into the standalone output", () => {
    const { root, chunk } = project();
    chunk("app", { version: 3, sources: ["../../../lib/server/x.ts"], names: [], mappings: "AAAA" });
    writeFileSync(path.join(root, ".next", "standalone", "Dockerfile"), "FROM node");
    expect(() => packServerSourceMaps(root)).toThrow(/Dockerfile; a dynamic filesystem call traced the whole project/u);
  });

  it("refuses to run without a standalone build", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aiqsa-source-maps-"));
    directories.push(root);
    expect(() => packServerSourceMaps(root)).toThrow(/standalone/u);
  });
});
