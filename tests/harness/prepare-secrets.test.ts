import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.resolve(process.cwd(), "prepare-secrets.sh");
const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "aiqsa-prepare-secrets-"));
  roots.push(root);
  return path.join(root, ".env");
}

function run(envFile: string, ...arguments_: string[]) {
  return spawnSync("bash", [script, "--env-file", envFile, ...arguments_], {
    encoding: "utf8"
  });
}

function envValues(body: string) {
  return Object.fromEntries(
    body
      .split("\n")
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("prepare-secrets.sh", () => {
  it("creates a private env file with valid generated first-install values", () => {
    const envFile = fixture();

    const result = run(envFile, "--admin-email", "owner@example.com");

    expect(result.status).toBe(0);
    const body = readFileSync(envFile, "utf8");
    const values = envValues(body);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(values.AIQSA_INITIAL_ADMIN_EMAIL).toBe("owner@example.com");
    expect(values.AIQSA_INITIAL_ADMIN_PASSWORD).toMatch(/^[0-9a-f]{36}$/);
    expect(values.AIQSA_AUTH_SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(values.AIQSA_POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
    expect(values.AIQSA_S3_SECRET_ACCESS_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(values.AIQSA_ENCRYPTION_KEY, "base64")).toHaveLength(32);
    expect(body).not.toContain("replace-with-");

    expect(result.stdout).toContain("Initial administrator credentials:");
    expect(result.stdout).toContain(values.AIQSA_INITIAL_ADMIN_PASSWORD);
    for (const key of [
      "AIQSA_AUTH_SESSION_SECRET",
      "AIQSA_ENCRYPTION_KEY",
      "AIQSA_POSTGRES_PASSWORD",
      "AIQSA_S3_SECRET_ACCESS_KEY"
    ]) {
      expect(result.stdout).not.toContain(values[key]);
    }
  });

  it("skips an existing env file without reading or changing it", () => {
    const envFile = fixture();
    const existing = "arbitrary content that is not an env file\n";
    writeFileSync(envFile, existing, { mode: 0o640 });
    chmodSync(envFile, 0o640);

    const result = run(envFile, "--admin-email", "different@example.com");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already exists; nothing was read or changed");
    expect(readFileSync(envFile, "utf8")).toBe(existing);
    expect(statSync(envFile).mode & 0o777).toBe(0o640);
  });

  it("leaves no env file behind when noninteractive email validation fails", () => {
    const envFile = fixture();

    const result = run(envFile, "--admin-email", "not-an-email");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--admin-email must be a plain valid email address");
    expect(() => statSync(envFile)).toThrow();
  });

  it("requires an explicit email when stdin is not interactive", () => {
    const envFile = fixture();

    const result = run(envFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rerun with --admin-email EMAIL");
    expect(() => statSync(envFile)).toThrow();
  });
});
