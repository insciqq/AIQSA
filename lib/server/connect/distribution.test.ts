import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectClientManifestSchema } from "@/lib/contracts/connect";
import {
  canonicalConnectOrigin,
  CONNECT_CLIENT_SUMS_FILE,
  CONNECT_CLIENT_TARGETS,
  connectClientDistDirectory,
  connectInstallScript,
  createConnectClientDistributionReader,
  createConnectDistributionHandlers
} from "./distribution";

const logs = vi.hoisted(() => ({ logEvent: vi.fn() }));
vi.mock("../observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../observability")>()),
  logEvent: logs.logEvent
}));

const NAMES = CONNECT_CLIENT_TARGETS.map((target) => `aiqsa-connect-${target.os}-${target.arch}`);
const VERSION = "1.2.3";

let root: string;
let dist: string;

/** A stand-in binary: a shell script that answers `version` like the client. */
function fakeBinary(name: string): string {
  return `#!/bin/sh\n# ${name}\n[ "$1" = version ] && echo ${VERSION}\n`;
}

function writeDist(): void {
  mkdirSync(dist, { recursive: true });
  const sums = NAMES.map((name) => {
    const body = fakeBinary(name);
    writeFileSync(path.join(dist, name), body, { mode: 0o755 });
    return `${createHash("sha256").update(body).digest("hex")}  ${name}\n`;
  });
  writeFileSync(path.join(dist, CONNECT_CLIENT_SUMS_FILE), sums.join(""));
}

function handlers(overrides: Partial<{ enabled: boolean | Error; origin: string | null }> = {}) {
  const enabled = overrides.enabled ?? true;
  return createConnectDistributionHandlers({
    distribution: createConnectClientDistributionReader(() => dist),
    origin: () => (overrides.origin === undefined ? "https://canonical.example" : overrides.origin),
    policy: { enabled: async () => { if (enabled instanceof Error) throw enabled; return enabled; } },
    version: VERSION
  });
}

const file = (name: string) => ({ params: Promise.resolve({ file: name }) });
const request = () => new Request("https://untrusted-host.example/connect/install.sh");

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "aiqsa-connect-dist-"));
  dist = connectClientDistDirectory(root);
  logs.logEvent.mockClear();
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

describe("AIQSA Connect client distribution", () => {
  it("serves connect/dist under the application root", () => {
    expect(connectClientDistDirectory("/app")).toBe("/app/connect/dist");
  });

  it("hides every public file while AIQSA Connect is off and refuses the manifest with connect_disabled", async () => {
    writeDist();
    const off = handlers({ enabled: false });
    for (const response of [await off.installScript(), await off.checksums(), await off.download(request(), file(NAMES[0]))]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const manifest = await off.manifest();
    expect(manifest.status).toBe(403);
    await expect(manifest.json()).resolves.toEqual({ code: "connect_disabled" });
  });

  it("answers 503 without a code while the switch cannot be read", async () => {
    writeDist();
    const response = await handlers({ enabled: new Error("database down") }).checksums();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  });

  it("answers connect_client_unavailable while the binaries are not built, logging it once", async () => {
    const on = handlers();
    for (const response of [
      await on.installScript(),
      await on.checksums(),
      await on.manifest(),
      await on.download(request(), file(NAMES[2]))
    ]) {
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ code: "connect_client_unavailable" });
    }
    expect(logs.logEvent.mock.calls.filter(([, fields]) => fields.code === "connect_client_unavailable")).toHaveLength(1);
  });

  it.each([
    ["a binary is missing", () => rmSync(path.join(dist, NAMES[1]))],
    ["a binary does not match its checksum", () => writeFileSync(path.join(dist, NAMES[3]), "tampered")],
    ["SHA256SUMS names an unknown file", () => writeFileSync(
      path.join(dist, CONNECT_CLIENT_SUMS_FILE),
      `${readFileSync(path.join(dist, CONNECT_CLIENT_SUMS_FILE), "utf8")}${"0".repeat(64)}  aiqsa-connect-windows-amd64\n`
    )],
    ["SHA256SUMS lacks a target", () => writeFileSync(
      path.join(dist, CONNECT_CLIENT_SUMS_FILE),
      readFileSync(path.join(dist, CONNECT_CLIENT_SUMS_FILE), "utf8").split("\n").slice(1).join("\n")
    )]
  ])("refuses an incomplete distribution when %s", async (_case, damage) => {
    writeDist();
    damage();
    const response = await handlers().manifest();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "connect_client_unavailable" });
  });

  it("notices a rebuilt distribution", async () => {
    writeDist();
    const on = handlers();
    expect((await on.manifest()).status).toBe(200);
    writeFileSync(path.join(dist, NAMES[0]), "rebuilt");
    const later = new Date(Date.now() + 5_000);
    utimesSync(path.join(dist, NAMES[0]), later, later);
    expect((await on.manifest()).status).toBe(503);
  });

  it("serves the manifest with every target", async () => {
    writeDist();
    const response = await handlers().manifest();
    expect(response.status).toBe(200);
    const manifest = connectClientManifestSchema.parse(await response.json());
    expect(manifest.version).toBe(VERSION);
    expect(manifest.targets.map((target) => `${target.os}-${target.arch}`)).toEqual(
      CONNECT_CLIENT_TARGETS.map((target) => `${target.os}-${target.arch}`)
    );
    for (const target of manifest.targets) {
      const body = fakeBinary(`aiqsa-connect-${target.os}-${target.arch}`);
      expect(target).toEqual({
        arch: target.arch,
        os: target.os,
        sha256: createHash("sha256").update(body).digest("hex"),
        size: Buffer.byteLength(body)
      });
    }
  });

  it("serves checksums.txt in sha256sum format", async () => {
    writeDist();
    const response = await handlers().checksums();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe(readFileSync(path.join(dist, CONNECT_CLIENT_SUMS_FILE), "utf8"));
  });

  it("serves exactly the four binaries with download headers", async () => {
    writeDist();
    const on = handlers();
    for (const name of NAMES) {
      const response = await on.download(request(), file(name));
      expect(response.status).toBe(200);
      expect(Object.fromEntries(response.headers)).toEqual({
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${name}"`,
        "content-length": String(statSync(path.join(dist, name)).size),
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff"
      });
      expect(await response.text()).toBe(fakeBinary(name));
    }
    for (const name of [CONNECT_CLIENT_SUMS_FILE, "aiqsa-connect-windows-amd64", "../package.json", "aiqsa-connect"]) {
      expect((await on.download(request(), file(name))).status).toBe(404);
    }
  });

  it("writes the canonical origin into install.sh, never the request's host", async () => {
    writeDist();
    const response = await handlers().installScript();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const script = await response.text();
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("set -eu");
    expect(script).toContain("origin='https://canonical.example'");
    expect(script).not.toContain("untrusted-host");
    expect(script).toContain("${AIQSA_CONNECT_INSTALL_DIR:-}");
    expect(script).toContain("login %s");

    const misconfigured = await handlers({ origin: null }).installScript();
    expect(misconfigured.status).toBe(503);
  });

  it.each([
    ["https://aiqsa.example/", "https://aiqsa.example"],
    ["https://aiqsa.example:8443/ignored-path", "https://aiqsa.example:8443"],
    ["http://[::1]:3000", "http://[::1]:3000"],
    ["https://user:secret@aiqsa.example", null],
    ["https://aiqsa.example?x=1", null],
    ["https://aiqsa.example#x", null],
    ["file:///tmp/x", null],
    ["not a url", null]
  ])("takes the origin of %s as %s", (baseUrl, origin) => {
    expect(canonicalConnectOrigin(baseUrl)).toBe(origin);
  });

  it("refuses to render an origin that is not shell-safe", () => {
    expect(() => connectInstallScript("https://aiqsa.example'; rm -rf ~; '")).toThrow();
  });
});

const run = promisify(execFile);
const hasTool = (name: string) => spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;
const canRunInstaller = ["darwin", "linux"].includes(process.platform) &&
  (hasTool("curl") || hasTool("wget")) && (hasTool("sha256sum") || hasTool("shasum"));

describe.skipIf(!canRunInstaller)("install.sh", () => {
  let server: Server;
  let origin: string;
  let tamper = false;

  beforeEach(async () => {
    writeDist();
    const on = handlers();
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const respond = async (): Promise<Response> => {
        if (url.pathname === "/connect/install.sh") return on.installScript();
        if (url.pathname === "/connect/checksums.txt") return on.checksums();
        if (url.pathname.startsWith("/connect/download/")) {
          if (tamper) return new Response("#!/bin/sh\necho tampered\n");
          return on.download(request(), file(url.pathname.slice("/connect/download/".length)));
        }
        return new Response(null, { status: 404 });
      };
      void respond().then(async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterEach(async () => {
    tamper = false;
    await new Promise((resolve) => server.close(resolve));
  });

  async function install(env: Record<string, string>) {
    const script = path.join(root, "install.sh");
    writeFileSync(script, connectInstallScript(origin));
    return run("sh", [script], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, timeout: 30_000 });
  }

  it("installs a verified, working binary into ~/.local/bin of a fresh HOME", async () => {
    const home = path.join(root, "home");
    mkdirSync(home);
    const { stdout } = await install({ HOME: home });
    const binary = path.join(home, ".local", "bin", "aiqsa-connect");
    expect(statSync(binary).mode & 0o777).toBe(0o755);
    expect((await run(binary, ["version"])).stdout.trim()).toBe(VERSION);
    expect(stdout).toContain(`Installed aiqsa-connect ${VERSION} as ${binary}`);
    expect(stdout).toContain("is not on your PATH");
    expect(stdout).toContain(`login ${origin}`);
    expect(stdout).toContain("service install");
  });

  it("honors AIQSA_CONNECT_INSTALL_DIR and replaces an earlier install", async () => {
    const dir = path.join(root, "bin");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "aiqsa-connect"), "old");
    const { stdout } = await install({ AIQSA_CONNECT_INSTALL_DIR: dir, HOME: root, PATH: `${dir}:${process.env.PATH}` });
    expect((await run(path.join(dir, "aiqsa-connect"), ["version"])).stdout.trim()).toBe(VERSION);
    expect(stdout).not.toContain("is not on your PATH");
    expect(stdout).toContain(`aiqsa-connect login ${origin}`);
  });

  it("installs nothing when the download does not match its checksum", async () => {
    tamper = true;
    const dir = path.join(root, "bin");
    mkdirSync(dir);
    await expect(install({ AIQSA_CONNECT_INSTALL_DIR: dir, HOME: root })).rejects.toMatchObject({
      stderr: expect.stringContaining("does not match its SHA-256 checksum")
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a relative install directory", async () => {
    await expect(install({ AIQSA_CONNECT_INSTALL_DIR: "bin", HOME: root })).rejects.toMatchObject({
      stderr: expect.stringContaining("must be an absolute path")
    });
  });
});
