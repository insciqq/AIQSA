import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSmokeInstalledPackage, assertSmokeNativeReport, auditSkillsAgentEvents,
  createSmokeSkill, parseSkillsAgentsSmokeTarget, SMOKE_TEMPLATE, smokeDigest
} from "./skills-mcp-agents-smoke-support";

const runId = "0123456789ab";
const target = { runId, baseUrl: "http://127.0.0.1:3210", databaseUrl:
  `postgresql://synthetic:synthetic@127.0.0.1:5544/aiqsa_skills_mcp_e2e_${runId}`,
workRoot: `/tmp/aiqsa-skills-agents-${runId}` };
const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("Skills real-agent qualification guards and independent oracles", () => {
  it("requires explicit isolated loopback app, database and workspace ownership", () => {
    expect(parseSkillsAgentsSmokeTarget(target, "DISPOSABLE")).toEqual(target);
    for (const [key, value] of [
      ["baseUrl", "https://example.org"], ["baseUrl", "http://127.0.0.1:3210/private"],
      ["databaseUrl", "postgresql://synthetic:synthetic@127.0.0.1:5544/aiqsa"],
      ["workRoot", "/tmp"], ["runId", "../../operator"], ["codexModel", "model;command"]
    ]) expect(() => parseSkillsAgentsSmokeTarget({ ...target, [key]: value }, "DISPOSABLE")).toThrow();
    expect(() => parseSkillsAgentsSmokeTarget(target, undefined)).toThrow("disposable_opt_in_required");
  });

  it("records actual tool events without inferring success from the answer", () => {
    const events = [
      { type: "item.completed", item: { type: "mcp_tool_call", tool: "list_skills", status: "completed" } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__skills__create_skill" }] } },
      { type: "user", message: { content: [{ type: "tool_result", is_error: true }] } },
      { type: "item.completed", item: { type: "agent_message", text: "All operations succeeded" } }
    ].map((item) => JSON.stringify(item)).join("\n");
    expect(auditSkillsAgentEvents(events)).toEqual({ tools: ["create_skill", "list_skills"],
      failedTools: 1, invalidLines: 0, agentMessages: 1, scriptExecutions: 0 });
  });

  it("distinguishes reading a packaged script from invoking it", () => {
    const events = ["cat .agents/skills/inventory-report/scripts/report.py", "python3 .agents/skills/inventory-report/scripts/report.py input.csv out.json"]
      .map(command => JSON.stringify({ type: "item.completed", item: { type: "command_execution", command } })).join("\n");
    expect(auditSkillsAgentEvents(events).scriptExecutions).toBe(1);
  });

  it("verifies binary/text payloads and executable flags independently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skills-agent-oracle-"));
    temporary.push(directory);
    await createSmokeSkill(directory);
    await assertSmokeInstalledPackage(directory);
    await writeFile(join(directory, "assets/template.bin"), "a plausible replacement");
    await expect(assertSmokeInstalledPackage(directory)).rejects.toThrow("installed_bytes_mismatch");
  });

  it("rejects plausible reports lacking the exact binary-backed arithmetic result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skills-agent-report-"));
    temporary.push(directory);
    const file = join(directory, "report.json");
    await writeFile(file, JSON.stringify({ rows: 3, total_cents: 2_070, template_sha256: smokeDigest(SMOKE_TEMPLATE) }));
    await assertSmokeNativeReport(file);
    await writeFile(file, JSON.stringify({ rows: 3, total_cents: 2_071, template_sha256: smokeDigest(SMOKE_TEMPLATE) }));
    await expect(assertSmokeNativeReport(file)).rejects.toThrow("native_report_invalid");
  });
});
