import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve("scripts/configure.sh");
const template = readFileSync(path.resolve(".env.example"), "utf8");
const directories: string[] = [];

function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiqsa-configure-test-"));
  directories.push(root);
  writeFileSync(path.join(root, ".env.example"), template);
  writeFileSync(path.join(root, "compose.yaml"), "services: {}\n");
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("installation configuration", () => {
  it("generates separate private secrets without printing them", () => {
    const root = fixture();
    const output = execFileSync("sh", [script], { cwd: root, encoding: "utf8" });
    const body = readFileSync(path.join(root, ".env"), "utf8");
    const values = Object.fromEntries(body.split("\n").filter((line) => /^AIQSA_\w+=/u.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    const hexKeys = ["AIQSA_INITIAL_ADMIN_PASSWORD", "AIQSA_AUTH_SESSION_SECRET", "AIQSA_POSTGRES_PASSWORD", "AIQSA_S3_SECRET_ACCESS_KEY"];
    for (const key of hexKeys) expect(values[key]).toMatch(/^[a-f0-9]{64}$/u);
    const base64Keys = ["AIQSA_ENCRYPTION_KEY", "AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY"];
    for (const key of base64Keys) expect(Buffer.from(values[key], "base64")).toHaveLength(32);
    expect(values.AIQSA_MEMORY_FINGERPRINT_KEYRING).toMatch(/^current=v1,v1=[A-Za-z0-9+/]{43}=$/u);
    const secrets = [...hexKeys, ...base64Keys, "AIQSA_MEMORY_FINGERPRINT_KEYRING"].map((key) => values[key]);
    expect(new Set(secrets).size).toBe(secrets.length);
    for (const secret of secrets) expect(output).not.toContain(secret);
    expect(statSync(path.join(root, ".env")).mode & 0o777).toBe(0o600);
    expect(values.AIQSA_INITIAL_ADMIN_EMAIL).toBe("");
    expect(readdirSync(root).filter((name) => name.startsWith(".env.tmp."))).toEqual([]);
  });

  it("preserves an existing installation byte for byte", () => {
    const root = fixture();
    const existing = "OPERATOR_CONFIGURATION=preserve-this\n";
    writeFileSync(path.join(root, ".env"), existing);
    const result = spawnSync("sh", [script], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(readFileSync(path.join(root, ".env"), "utf8")).toBe(existing);
    expect(result.stdout + result.stderr).not.toContain("preserve-this");
  });

  it("does not publish a partial configuration if entropy generation fails", () => {
    const root = fixture();
    writeFileSync(path.join(root, "openssl"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
    const result = spawnSync("sh", [script], {
      cwd: root,
      env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}` },
      encoding: "utf8"
    });
    expect(result.status).not.toBe(0);
    expect(readdirSync(root)).not.toContain(".env");
    expect(readdirSync(root).filter((name) => name.startsWith(".env.tmp."))).toEqual([]);
  });
});
