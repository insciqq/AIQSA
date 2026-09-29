import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export function smokeAssert(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`skills_agents_${code}`);
}

export function smokeDigest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Explicit loopback-only target supplied by the disposable stand's owner. */
export type SkillsAgentsSmokeTarget = {
  baseUrl: string;
  databaseUrl: string;
  runId: string;
  workRoot: string;
  codexModel?: string;
  claudeModel?: string;
};

export function parseSkillsAgentsSmokeTarget(value: unknown, optIn: string | undefined): SkillsAgentsSmokeTarget {
  smokeAssert(optIn === "DISPOSABLE", "disposable_opt_in_required");
  smokeAssert(value && typeof value === "object" && !Array.isArray(value), "target_invalid");
  const target = value as Record<string, unknown>;
  smokeAssert(typeof target.baseUrl === "string" && typeof target.databaseUrl === "string" &&
    typeof target.runId === "string" && /^[a-f0-9]{12}$/u.test(target.runId) &&
    typeof target.workRoot === "string", "target_invalid");
  const base = new URL(target.baseUrl);
  const db = new URL(target.databaseUrl);
  const loopback = (hostname: string) => ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
  smokeAssert(base.protocol === "http:" && loopback(base.hostname) && base.port &&
    !base.username && !base.password && base.pathname === "/" && !base.search && !base.hash,
  "app_target_not_disposable");
  smokeAssert(db.protocol === "postgresql:" && loopback(db.hostname) && db.port &&
    db.username && db.password && db.pathname === `/aiqsa_skills_mcp_e2e_${target.runId}` &&
    !db.hash && [...db.searchParams.keys()].every((key) => key === "schema"), "database_target_not_disposable");
  smokeAssert(resolve(target.workRoot) === `/tmp/aiqsa-skills-agents-${target.runId}`, "workspace_not_owned");
  for (const key of ["codexModel", "claudeModel"] as const) {
    smokeAssert(target[key] === undefined || typeof target[key] === "string" &&
      /^[a-zA-Z0-9._-]{1,100}$/u.test(target[key]), "model_invalid");
  }
  return { ...target, baseUrl: base.origin } as SkillsAgentsSmokeTarget;
}

export type CapturedAgentProcess = {
  child: ChildProcess;
  output(): string;
  done: Promise<{ code: number; stdout: string; stderr: string }>;
};

export function killSmokeProcess(child: ChildProcess): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

/** Raw output is bounded and private; callers emit only independent aggregate evidence. */
export function spawnSmokeProcess(command: string, args: readonly string[], input: {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; stdin?: string;
}): CapturedAgentProcess {
  const child = spawn(command, [...args], { cwd: input.cwd, env: input.env,
    detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let overflow = false;
  const append = (current: string, chunk: Buffer) => {
    if (Buffer.byteLength(current) + chunk.length > 12 * 1_024 * 1_024) {
      overflow = true;
      killSmokeProcess(child);
      return current;
    }
    return current + chunk.toString("utf8");
  };
  child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  child.stdin?.end(input.stdin);
  const done = new Promise<{ code: number; stdout: string; stderr: string }>((accept, reject) => {
    const timer = setTimeout(() => { killSmokeProcess(child); reject(new Error("skills_agents_client_timeout")); },
      input.timeoutMs ?? 300_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("skills_agents_client_spawn_failed")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (overflow) reject(new Error("skills_agents_client_output_limit"));
      else accept({ code: code ?? 1, stdout, stderr });
    });
  });
  // OAuth coordination may inspect output before awaiting termination.
  void done.catch(() => undefined);
  return { child, done, output: () => `${stdout}\n${stderr}` };
}

export function auditSkillsAgentEvents(output: string): {
  tools: string[]; failedTools: number; invalidLines: number; agentMessages: number; scriptExecutions: number;
} {
  const tools = new Set<string>();
  let failedTools = 0;
  let invalidLines = 0;
  let agentMessages = 0;
  let scriptExecutions = 0;
  const executesScript = (value: unknown) => typeof value === "string" &&
    /(?:\bpython(?:3)?\s+["']?[\w/.~-]*scripts\/report\.py(?:[\s"']|$)|(?:^|(?:&&|;)\s*| -[lc]+\s+["'])["']?[\w/.~-]*scripts\/report\.py(?:[\s"']|$))/u.test(value);
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let item: Record<string, unknown>;
    try { item = JSON.parse(line) as Record<string, unknown>; }
    catch { invalidLines += 1; continue; }
    const eventItem = item.item as Record<string, unknown> | undefined;
    if (eventItem?.type === "mcp_tool_call" && item.type === "item.completed") {
      if (typeof eventItem.tool === "string") tools.add(eventItem.tool);
      if (eventItem.status === "failed" || (eventItem.result as { isError?: boolean })?.isError) failedTools += 1;
    }
    if (eventItem?.type === "agent_message") agentMessages += 1;
    if (eventItem?.type === "command_execution" && item.type === "item.completed" && executesScript(eventItem.command)) scriptExecutions += 1;
    const message = item.message as { content?: Array<{ type?: string; name?: string; is_error?: boolean; input?: { command?: string } }> } | undefined;
    for (const block of message?.content ?? []) {
      if (block.type === "tool_use" && block.name?.startsWith("mcp__")) tools.add(block.name.split("__").at(-1)!);
      if (block.type === "tool_result" && block.is_error) failedTools += 1;
      if (block.type === "text") agentMessages += 1;
      if (block.type === "tool_use" && block.name === "Bash" && executesScript(block.input?.command)) scriptExecutions += 1;
    }
  }
  return { tools: [...tools].sort(), failedTools, invalidLines, agentMessages, scriptExecutions };
}

export const SMOKE_SKILL_NAME = "inventory-report";
export const SMOKE_TEMPLATE = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
export const SMOKE_REFERENCE = "Inventory totals use quantity multiplied by unit price in integer cents.\n";
export const SMOKE_SCRIPT = `#!/usr/bin/env python3
import csv, hashlib, json, pathlib, sys
root = pathlib.Path(__file__).resolve().parent.parent
rows = list(csv.DictReader(pathlib.Path(sys.argv[1]).open()))
total = sum(int(row['quantity']) * int(row['unit_cents']) for row in rows)
template = (root / 'assets' / 'template.bin').read_bytes()
report = {'rows': len(rows), 'total_cents': total, 'template_sha256': hashlib.sha256(template).hexdigest()}
pathlib.Path(sys.argv[2]).write_text(json.dumps(report, sort_keys=True) + '\\n')
`;

export function smokeSkillMarkdown(revision = 1): string {
  return `---\nname: ${SMOKE_SKILL_NAME}\ndescription: Prepare a precise inventory value report from a quantity and unit cents CSV.\nmetadata:\n  fixture-revision: "${revision}"\n---\n\nRead references/rules.txt. Run the bundled executable scripts/report.py with the input CSV path and requested output JSON path. It uses assets/template.bin; preserve that binary template. Do not calculate or fabricate the report yourself. No network, package installation, or MCP is needed to use this installed skill.\n`;
}

export async function createSmokeSkill(directory: string, revision = 1): Promise<void> {
  for (const child of ["references", "scripts", "assets"]) await mkdir(join(directory, child), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "SKILL.md"), smokeSkillMarkdown(revision), { mode: 0o600 });
  await writeFile(join(directory, "references/rules.txt"), SMOKE_REFERENCE, { mode: 0o600 });
  await writeFile(join(directory, "scripts/report.py"), SMOKE_SCRIPT, { mode: 0o700 });
  await writeFile(join(directory, "assets/template.bin"), SMOKE_TEMPLATE, { mode: 0o600 });
}

export async function assertSmokeInstalledPackage(directory: string): Promise<void> {
  for (const [relative, expected] of [
    ["references/rules.txt", Buffer.from(SMOKE_REFERENCE)],
    ["scripts/report.py", Buffer.from(SMOKE_SCRIPT)],
    ["assets/template.bin", SMOKE_TEMPLATE]
  ] as const) {
    smokeAssert((await readFile(join(directory, relative))).equals(expected), "installed_bytes_mismatch");
  }
  smokeAssert(Boolean((await lstat(join(directory, "scripts/report.py"))).mode & 0o111), "executable_mode_lost");
}

export async function assertSmokeNativeReport(file: string): Promise<void> {
  const result = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  smokeAssert(result.rows === 3 && result.total_cents === 2_070 &&
    result.template_sha256 === smokeDigest(SMOKE_TEMPLATE) && Object.keys(result).length === 3,
  "native_report_invalid");
}
