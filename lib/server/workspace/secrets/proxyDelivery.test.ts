import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toProxyRunPlan, type ProxyRunPlanEntry } from "@/lib/contracts/proxies";
import { WORKSPACE_GUIDE_FILES, workspaceGuideInput, WORKSPACE_PROXY_GUIDANCE } from "../guides";
import { runProxiesFromRows } from "../../proxies/runProxies";
import { INSTALL_WORKSPACE_SECRETS } from "./guest";
import {
  parseWorkspaceRunProxies, workspaceProxyPlanEntry, WORKSPACE_PROXY_PLAN_PATH, workspaceRunProxies, workspaceSecretsGuide
} from "./manifest";

const PASSWORD = "synthetic-proxy-password";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function entry(id: string, overrides: Partial<ProxyRunPlanEntry> = {}): ProxyRunPlanEntry {
  return { active: true, country: "KZ", domainHints: [".kz"], host: `${id}.example.com`, id, name: id.toUpperCase(), owner: "personal",
    port: 1080, protocol: "socks5", ...overrides };
}

const row = (id: string) => ({ active: true, host: `${id}.example.com`, id, login: "synthetic-login", password: PASSWORD, port: 1080, protocol: "socks5" as const });

/** The fixed install script on real Python, under a scratch directory that stands for the guest's root. */
function guest() {
  const root = mkdtempSync(join(tmpdir(), "aiqsa-proxy-delivery-"));
  directories.push(root);
  const script = INSTALL_WORKSPACE_SECRETS.replaceAll("'/workspace", `'${root}/workspace`).replaceAll("'/root", `'${root}/root`);
  return {
    install(secrets: readonly unknown[]) {
      return spawnSync("python3", ["-I", "-c", script], { encoding: "utf8", timeout: 10_000,
        input: JSON.stringify({ environment: {}, guide: workspaceSecretsGuide([]), runId: "run", secrets }) });
    },
    root,
    plan: join(root, WORKSPACE_PROXY_PLAN_PATH)
  };
}

describe("a run's proxies on the way to the guest", () => {
  it("joins the plan with what loaded, so a proxy that cannot be used still travels and holds its sites", async () => {
    const plan = toProxyRunPlan([entry("good"), entry("gone"), entry("off", { active: false })])!;
    const loaded = await runProxiesFromRows([row("good"), row("off")]).load({ plan, userId: "user" });
    const proxies = workspaceRunProxies(plan, loaded);
    expect(proxies.map(({ available, id, password }) => ({ available, id, password }))).toEqual([
      { available: true, id: "good", password: PASSWORD },
      { available: false, id: "gone", password: null },
      { available: false, id: "off", password: null }
    ]);
    expect(parseWorkspaceRunProxies(proxies)).toEqual(proxies);
  });

  it("installs a mode 0600 managed file that the next install without proxies removes", () => {
    const value = guest();
    const proxies = workspaceRunProxies(toProxyRunPlan([entry("good")])!, { connections: [{ ...entry("good"), login: "synthetic-login", password: PASSWORD }], unavailable: [] });
    expect(value.install([workspaceProxyPlanEntry(proxies)]).status).toBe(0);
    expect(statSync(value.plan).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(value.plan, "utf8"))).toEqual({ version: 1, proxies });
    expect(readFileSync(join(value.root, "workspace/secrets/.environment.json"), "utf8")).not.toContain(PASSWORD);
    expect(readFileSync(join(value.root, "workspace/SECRETS.md"), "utf8")).not.toContain(PASSWORD);
    expect(existsSync(join(value.root, "workspace/project"))).toBe(false);

    expect(value.install([]).status).toBe(0);
    expect(existsSync(value.plan)).toBe(false);
    expect(readdirSync(join(value.root, "workspace/secrets/files"))).toEqual([]);
  });

  it("is what the guest's own reader accepts", () => {
    const value = guest();
    const proxies = workspaceRunProxies(toProxyRunPlan([entry("good"), entry("gone")])!, { connections: [{ ...entry("good"), login: null, password: null }], unavailable: [] });
    expect(value.install([workspaceProxyPlanEntry(proxies)]).status).toBe(0);
    const read = spawnSync("python3", ["-c", `
import pathlib, sys
from aiqsa.proxy import _plan
plan = _plan.load(pathlib.Path(sys.argv[1]))
print(plan.by_id["good"]["available"], plan.unavailable)
`, value.plan], { encoding: "utf8", env: { ...process.env, PYTHONPATH: join(process.cwd(), "ops/workspace-guest/python") }, timeout: 10_000 });
    expect(read.stderr).toBe("");
    expect(read.stdout.trim()).toBe("True ['gone']");
  });

  it("refuses what it cannot trust, rather than dropping a proxy whose sites would then open directly", () => {
    const good = workspaceRunProxies(toProxyRunPlan([entry("good")])!, { connections: [], unavailable: [] })[0]!;
    expect(parseWorkspaceRunProxies(undefined)).toEqual([]);
    for (const value of [
      "proxies", [null], [{ ...good, port: 0 }], [{ ...good, protocol: "ftp" }], [{ ...good, domainHints: ["KZ"] }], [{ ...good, extra: 1 }],
      [{ ...good, password: "x".repeat(256) }], [{ ...good, available: "yes" }], [good, good], Array.from({ length: 201 }, (_, index) => ({ ...good, id: `p${index}` }))
    ]) expect(() => parseWorkspaceRunProxies(value)).toThrow();
  });
});

describe("the guide", () => {
  it("reaches the browser guide within its bound, and names only commands the guest has", () => {
    const browser = WORKSPACE_GUIDE_FILES.find((file) => file.name === "browser.md")!.content;
    expect(browser).toContain(WORKSPACE_PROXY_GUIDANCE);
    expect(Buffer.byteLength(browser)).toBeLessThanOrEqual(32_768);
    const input = JSON.parse(workspaceGuideInput({ agentKind: "subagent" }).toString()) as { guides: { content: string; name: string }[] };
    expect(input.guides.find((guide) => guide.name === "browser.md")!.content).toContain(WORKSPACE_PROXY_GUIDANCE);
    const cli = readFileSync(join(process.cwd(), "ops/workspace-guest/python/aiqsa/browser/cli.py"), "utf8");
    for (const command of ["proxies", "proxied"]) expect(cli).toContain(`add_parser("${command}"`);
    expect(WORKSPACE_PROXY_GUIDANCE).toContain(WORKSPACE_PROXY_PLAN_PATH);
    const paths = readFileSync(join(process.cwd(), "ops/workspace-guest/python/aiqsa/browser/_paths.py"), "utf8");
    expect(paths).toContain(WORKSPACE_PROXY_PLAN_PATH);
  });
});
