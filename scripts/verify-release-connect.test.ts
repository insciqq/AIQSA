import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONNECT_CLIENT_TARGETS } from "@/lib/server/connect/distribution";
import { connectClientBinaryName } from "@/lib/contracts/connect";

type VerifyInput = Readonly<{ arch?: string; dist: string; platform?: string; release: boolean; root: string; version: string }>;
const verifier = createRequire(import.meta.url)("./verify-release-connect.cjs") as {
  CONNECT_RELEASE_NAMES: readonly string[];
  hostBinaryName(platform?: string, arch?: string): string | null;
  verifyConnectDist(input: VerifyInput): void;
};

const VERSION = "1.2.3";
let dist: string;

/** Every target a shell script that answers `version`; only the host's ever runs. */
function writeDist(names: readonly string[] = verifier.CONNECT_RELEASE_NAMES): void {
  const sums = names.map((name) => {
    const body = `#!/bin/sh\n# ${name}\n[ "$1" = version ] && echo ${VERSION}\n`;
    writeFileSync(path.join(dist, name), body, { mode: 0o755 });
    return `${createHash("sha256").update(body).digest("hex")}  ${name}\n`;
  });
  writeFileSync(path.join(dist, "SHA256SUMS"), sums.join(""));
}

const verify = (input: Partial<VerifyInput> = {}) =>
  verifier.verifyConnectDist({ arch: "x64", dist, platform: "linux", release: false, root: dist, version: VERSION, ...input });

beforeEach(() => {
  dist = mkdtempSync(path.join(tmpdir(), "aiqsa-connect-release-"));
});

afterEach(() => {
  rmSync(dist, { force: true, recursive: true });
});

describe("verify-release-connect", () => {
  it("checks the six release files the server serves, Windows ones with .exe", () => {
    expect(verifier.CONNECT_RELEASE_NAMES).toEqual(
      CONNECT_CLIENT_TARGETS.map((target) => connectClientBinaryName(target.os, target.arch))
    );
    expect(verifier.CONNECT_RELEASE_NAMES.filter((name) => name.endsWith(".exe"))).toHaveLength(2);
  });

  it("runs only the host's own binary", () => {
    expect(verifier.hostBinaryName("linux", "x64")).toBe("aiqsa-connect-linux-amd64");
    expect(verifier.hostBinaryName("darwin", "arm64")).toBe("aiqsa-connect-darwin-arm64");
    expect(verifier.hostBinaryName("win32", "x64")).toBeNull();
    expect(verifier.hostBinaryName("linux", "ia32")).toBeNull();
  });

  it.skipIf(process.platform === "win32")("accepts a complete distribution whose host binary reports the version", () => {
    writeDist();
    expect(() => verify()).not.toThrow();
    expect(() => verify({ version: "9.9.9" })).toThrow("connect_release_version_invalid");
  });

  it("refuses a missing Windows binary and a checksum that does not match", () => {
    writeDist(verifier.CONNECT_RELEASE_NAMES.filter((name) => name !== "aiqsa-connect-windows-arm64.exe"));
    expect(() => verify()).toThrow("connect_release_files_invalid");
    writeDist();
    writeFileSync(path.join(dist, "aiqsa-connect-windows-amd64.exe"), "tampered");
    expect(() => verify()).toThrow("connect_release_checksums_invalid");
  });
});
