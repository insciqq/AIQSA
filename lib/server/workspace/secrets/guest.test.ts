import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INSTALL_WORKSPACE_SECRETS, READ_WORKSPACE_SECRET_ENV, WORKSPACE_SECRET_ENV_EXIT } from "./guest";

const directories: string[] = [];

/** The fixed guest scripts on real Python, under a scratch directory that stands for the guest's root. */
function guest() {
  const root = mkdtempSync(join(tmpdir(), "aiqsa-secret-env-"));
  directories.push(root);
  const rooted = (script: string) => script.replaceAll("'/workspace", `'${root}/workspace`).replaceAll("'/root", `'${root}/root`);
  const managed = join(root, "workspace", "secrets");
  const marker = join(managed, ".environment.json");
  return {
    install(runId: string, environment: Readonly<Record<string, string>>) {
      return spawnSync("python3", ["-I", "-c", rooted(INSTALL_WORKSPACE_SECRETS)], { encoding: "utf8",
        input: JSON.stringify({ environment, guide: "guide", runId, secrets: [] }), timeout: 10_000 });
    },
    managed,
    marker,
    prepare(content: string) {
      mkdirSync(managed, { recursive: true });
      writeFileSync(marker, content);
    },
    read(runId: string, locale?: string) {
      return spawnSync("python3", ["-I", "-c", rooted(READ_WORKSPACE_SECRET_ENV), runId], { encoding: "utf8", timeout: 10_000,
        env: { ...process.env, ...(locale ? { LC_ALL: locale } : {}) } });
    },
    root
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("a run's saved environment in the guest", () => {
  it("keeps every run's own values, and a run's next install replaces only its own", () => {
    const value = guest();
    expect(value.install("run_main", { SHARED: "main", AIQSA_AGENT_ID: "forged" }).status).toBe(0);
    expect(value.install("run_subagent", { SHARED: "subagent" }).status).toBe(0);
    expect(value.install("run_main", { SHARED: "main again" }).status).toBe(0);
    expect((JSON.parse(readFileSync(value.marker, "utf8")) as { runs: Array<{ runId: string }> }).runs.map((run) => run.runId))
      .toEqual(["run_subagent", "run_main"]);
    expect(JSON.parse(value.read("run_main").stdout)).toEqual({ SHARED: "main again" });
    expect(JSON.parse(value.read("run_subagent").stdout)).toEqual({ SHARED: "subagent" });
  });

  it("reads a file written before runs had their own entries", () => {
    const value = guest();
    value.prepare(JSON.stringify({ runId: "run_old", values: { OLD: "value" } }));
    expect(JSON.parse(value.read("run_old").stdout)).toEqual({ OLD: "value" });
    expect(value.read("run_other").status).toBe(WORKSPACE_SECRET_ENV_EXIT.missing);
  });

  it("reads a non-ASCII value whatever the guest's locale", () => {
    const value = guest();
    expect(value.install("run_main", { GREETING: "привет ✓" }).status).toBe(0);
    expect(JSON.parse(value.read("run_main", "POSIX").stdout)).toEqual({ GREETING: "привет ✓" });
  });

  it("tells a run with no entry from a file it cannot trust, printing nothing either way", () => {
    const missing = guest();
    expect(missing.read("run_main")).toMatchObject({ status: WORKSPACE_SECRET_ENV_EXIT.missing, stderr: "", stdout: "" });
    missing.prepare("{}");
    expect(missing.read("run_main")).toMatchObject({ status: WORKSPACE_SECRET_ENV_EXIT.missing, stderr: "", stdout: "" });
    expect(missing.install("run_other", { OTHER: "value" }).status).toBe(0);
    expect(missing.read("run_main")).toMatchObject({ status: WORKSPACE_SECRET_ENV_EXIT.missing, stderr: "", stdout: "" });

    for (const content of ["", "{\"runs\": [", "[1]", "\"text\"", "{\"runs\": [{\"runId\": \"run_main\"}]}"]) {
      const corrupt = guest();
      corrupt.prepare(content);
      expect(corrupt.read("run_main")).toMatchObject({ status: WORKSPACE_SECRET_ENV_EXIT.unreadable, stderr: "", stdout: "" });
    }

    const linkedFile = guest();
    linkedFile.prepare("{}");
    rmSync(linkedFile.marker);
    symlinkSync("/etc/hostname", linkedFile.marker);
    expect(linkedFile.read("run_main")).toMatchObject({ status: WORKSPACE_SECRET_ENV_EXIT.unreadable, stdout: "" });

    const linkedDirectory = guest();
    mkdirSync(join(linkedDirectory.root, "workspace"));
    mkdirSync(join(linkedDirectory.root, "elsewhere"));
    symlinkSync(join(linkedDirectory.root, "elsewhere"), linkedDirectory.managed);
    expect(linkedDirectory.read("run_main")).toMatchObject({ status: WORKSPACE_SECRET_ENV_EXIT.unreadable, stdout: "" });
  });

  it("installs over a file a crash left corrupt, so one bad file never locks a Workspace out", () => {
    for (const content of ["", "{\"runs\": [", "[1]"]) {
      const value = guest();
      value.prepare(content);
      expect(value.install("run_main", { TOKEN: "value" }).status).toBe(0);
      expect(JSON.parse(value.read("run_main").stdout)).toEqual({ TOKEN: "value" });
    }
  });

  it("still refuses a marker that is not a plain file", () => {
    const value = guest();
    value.prepare("{}");
    rmSync(value.marker);
    symlinkSync("/etc/hostname", value.marker);
    expect(value.install("run_main", { TOKEN: "value" }).status).toBe(1);
  });
});
