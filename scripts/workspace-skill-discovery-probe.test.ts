// @vitest-environment node
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_VERSION, renderCodexManagedProfile } from "@/lib/server/agents/codexProfile";
import { INSTALL_CODEX_PROFILE } from "@/lib/server/agents/guest";
import { nativeSkillDiscoveryCommand, nativeSkillDiscoveryReceipt } from "./workspace-skill-discovery-probe";

const owned: string[] = [];
afterEach(async () => { for (const directory of owned.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function guest() {
  const directory = await mkdtemp(join(tmpdir(), "aiqsa-native-probe-test-"));
  owned.push(directory);
  const workspace = join(directory, "workspace");
  const home = join(directory, "home");
  const project = join(workspace, "project");
  const codex = join(directory, "codex-stub");
  const responses = join(directory, "responses.json");
  const requests = join(directory, "requests.jsonl");
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  const substitute = (source: string) => source.replaceAll("/workspace", workspace).replaceAll("/root", home).replaceAll("/usr/local/bin/codex", codex);
  await writeFile(codex, `#!/usr/bin/python3
import json, sys
if '--version' in sys.argv:
    print('codex-cli ${CODEX_VERSION}')
else:
    for line in sys.stdin:
        value = json.loads(line)
        with open(${JSON.stringify(requests)}, 'a') as recorded: recorded.write(json.dumps(value) + '\\n')
        if value['method'] == 'initialize': print(json.dumps({'id': 1, 'result': {}}), flush=True)
        elif value['method'] == 'skills/list':
            result = json.load(open(${JSON.stringify(responses)}))
            if result.get('oversize'):
                print('X' * 524289, flush=True)
            else:
                print(json.dumps({'method': 'skills/changed'}), flush=True)
                print(json.dumps({'id': 2, **result}), flush=True)
        elif value['method'] != 'initialized': sys.exit(4)
`);
  await chmod(codex, 0o755);
  const execute = (payload: Record<string, unknown>) => spawnSync("/bin/sh", ["-c", substitute(nativeSkillDiscoveryCommand({ version: CODEX_VERSION, ...payload }))], {
    env: { ...process.env, HOME: home, CODEX_HOME: join(workspace, ".aiqsa/codex") },
    encoding: "utf8", timeout: 10_000, maxBuffer: 4096
  });
  const config = renderCodexManagedProfile({ gatewayOrigin: "http://127.0.0.1:9", modelId: "synthetic-no-model",
    contextWindowTokens: 128000, maxOutputTokens: 16000, mcpMode: "off", mcpTimeoutSeconds: 10, developerInstructions: "Synthetic." });
  const setup = execute({ phase: "setup", installer: substitute(INSTALL_CODEX_PROFILE), config });
  expect(setup.status).toBe(0);
  expect(JSON.parse(setup.stdout)).toEqual({ ok: true });
  const bundles = [
    { alias: "pinned", discover: false, marker: "pinned-script" },
    { alias: "available", discover: true, marker: "available-script" }
  ];
  await mkdir(join(home, ".agents/skills"), { recursive: true });
  for (const item of bundles) {
    const folder = join(workspace, ".aiqsa/skills", item.alias);
    await mkdir(join(folder, "scripts"), { recursive: true });
    await chmod(folder, 0o755);
    await writeFile(join(folder, "SKILL.md"), "Synthetic pinned or available instructions.", { mode: 0o644 });
    await writeFile(join(folder, "scripts/run.sh"), `#!/bin/sh\nprintf '%s\\n' '${item.marker}'\n`, { mode: 0o755 });
    if (item.discover) await symlink(folder, join(home, ".agents/skills", item.alias));
  }
  const skills = [
    { name: "available", scope: "user", enabled: true, path: join(workspace, ".aiqsa/skills/available/SKILL.md") },
    { name: "aiqsa-project-agents-live", scope: "repo", enabled: true, path: join(project, ".agents/skills/aiqsa-project-agents-live/SKILL.md") },
    { name: "aiqsa-project-codex-live", scope: "repo", enabled: true, path: join(project, ".codex/skills/aiqsa-project-codex-live/SKILL.md") }
  ];
  const publish = async (value: unknown) => writeFile(responses, JSON.stringify(value));
  const catalog = (items: unknown[] = skills) => ({ result: { data: [{ cwd: project, errors: [], skills: items }] } });
  const inspect = () => execute({ phase: "inspect", pinnedAlias: "pinned", bundles, expectStale: false });
  await publish(catalog());
  return { directory, workspace, home, project, skills, inspect, catalog, publish, requests, config };
}

describe("no-model native Skill discovery probe", () => {
  it("uses initialize/skills-list only, follows user links, preserves project discovery and installs the managed profile", async () => {
    const value = await guest();
    const result = value.inspect();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(nativeSkillDiscoveryReceipt(JSON.parse(result.stdout))).toEqual({ availableCount: 1, projectCount: 2 });
    expect(await readFile(join(value.workspace, ".aiqsa/codex/config.toml"), "utf8")).toBe(value.config);
    const requests = (await readFile(value.requests, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method: string; params?: unknown });
    expect(requests.map(item => item.method)).toEqual(["initialize", "initialized", "skills/list"]);
    expect(requests[2]!.params).toEqual({ cwds: [value.project], forceReload: true });
    expect(result.stdout).not.toContain(value.project);
    expect(result.stdout).not.toContain("Synthetic");
  });

  it.each(["bundled", "pinned", "scope", "target", "disabled"] as const)("fails qualification for %s discovery drift without printing catalog contents", async mode => {
    const value = await guest();
    const skills = value.skills.map(item => ({ ...item }));
    if (mode === "bundled") skills.push({ name: "skill-creator", scope: "system", enabled: true, path: "PRIVATE_SKILL_PATH_CANARY" });
    if (mode === "pinned") skills.push({ name: "pinned", scope: "user", enabled: true, path: "PRIVATE_SKILL_PATH_CANARY" });
    if (mode === "scope") skills[0]!.scope = "repo";
    if (mode === "target") skills[0]!.path = "PRIVATE_SKILL_PATH_CANARY";
    if (mode === "disabled") skills[0]!.enabled = false;
    await value.publish(value.catalog(skills));
    const result = value.inspect();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: expect.stringMatching(/^codex_/u) });
    expect(result.stdout + result.stderr).not.toContain("PRIVATE_SKILL_PATH_CANARY");
    expect(result.stderr).toBe("");
  });

  it.each(["error", "oversize"] as const)("bounds and sanitizes a native %s response", async mode => {
    const value = await guest();
    await value.publish(mode === "error" ? { error: { message: "PRIVATE_NATIVE_ERROR_CANARY", data: { token: "PRIVATE_TOKEN_CANARY" } } } : { oversize: true });
    const result = value.inspect();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, code: mode === "error" ? "codex_request_failed" : "codex_discovery_limit" });
    expect(result.stdout).not.toContain("PRIVATE_");
  });

  it("accepts only aggregate receipts and shell-quotes the probe payload", () => {
    const receipt = { ok: true, availableCount: 1, projectCount: 2, bundledCount: 0, pinnedDiscoveries: 0, executable: true };
    expect(nativeSkillDiscoveryReceipt(receipt)).toEqual({ availableCount: 1, projectCount: 2 });
    for (const invalid of [null, { ...receipt, raw: "source" }, { ...receipt, bundledCount: 1 }, { ...receipt, availableCount: -1 },
      { ...receipt, projectCount: 1 }, { ...receipt, availableCount: 101 }, { ...receipt, executable: false }]) {
      expect(nativeSkillDiscoveryReceipt(invalid)).toBeNull();
    }
    const payload = { quote: "' $(touch /tmp/should-never-exist) `echo never`\n" };
    const command = nativeSkillDiscoveryCommand(payload);
    expect(command).not.toContain(payload.quote);
    expect(command).toContain(Buffer.from(JSON.stringify(payload)).toString("base64"));
  });
});
