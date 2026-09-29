/**
 * Opt-in paid qualification against an externally prepared disposable stand.
 * AIQSA_SKILLS_AGENTS_SMOKE=DISPOSABLE AIQSA_SKILLS_AGENTS_TARGET=/tmp/target.json
 * node --import tsx scripts/smoke-skills-mcp-agents.ts
 *
 * The target JSON is private (0600): baseUrl, databaseUrl, runId, workRoot,
 * optional codexModel/claudeModel. It never loads .env or operator app state.
 * The stand owner destroys its database after qualification. This harness only
 * creates synthetic owner state, revokes its grants and removes isolated clients.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { hashPassword } from "../lib/server/auth/password";
import { codexLbOverridesFromConfig, findAuthorizationUrl } from "./memory-mcp-codex-smoke-support";
import {
  assertSmokeInstalledPackage, assertSmokeNativeReport, auditSkillsAgentEvents,
  createSmokeSkill, killSmokeProcess, parseSkillsAgentsSmokeTarget,
  SMOKE_SCRIPT, SMOKE_SKILL_NAME, SMOKE_TEMPLATE, smokeAssert, smokeDigest,
  smokeSkillMarkdown, spawnSmokeProcess, type SkillsAgentsSmokeTarget
} from "./skills-mcp-agents-smoke-support";

const emit = (stage: string, fields: Record<string, unknown> = {}) =>
  process.stdout.write(`${JSON.stringify({ stage, ...fields })}\n`);
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
let privateFailurePath: string | undefined;

export type Client = {
  kind: "codex" | "claude";
  directory: string;
  configuration: string;
  env: NodeJS.ProcessEnv;
  providerArgs: string[];
  version: string;
  grantId?: string;
};

function clientEnvironment(): NodeJS.ProcessEnv {
  // Only platform essentials and the explicitly selected provider reach clients.
  return { NODE_ENV: process.env.NODE_ENV ?? "production", ...Object.fromEntries(
    ["PATH", "LANG", "LC_ALL", "SHELL", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR"]
      .flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : [])) };
}

async function run(command: string, args: readonly string[], client: Pick<Client, "directory" | "env">,
  timeoutMs = 300_000, stdin?: string) {
  return spawnSmokeProcess(command, args, { cwd: client.directory, env: client.env, timeoutMs, stdin }).done;
}

async function approveOAuth(page: Page, authorizationUrl: string, target: SkillsAgentsSmokeTarget, write: boolean) {
  const url = new URL(authorizationUrl);
  smokeAssert(url.origin === target.baseUrl && url.pathname === "/oauth/authorize" &&
    url.searchParams.get("resource") === `${target.baseUrl}/mcp/skills` &&
    url.searchParams.get("code_challenge_method") === "S256", "oauth_request_invalid");
  const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
  smokeAssert(["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname), "oauth_callback_not_loopback");
  const response = await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  smokeAssert(response?.ok(), "oauth_consent_unavailable");
  await page.getByRole("heading", { name: "Connect Skills?" }).waitFor({ timeout: 30_000 });
  const checkbox = page.locator('input[name="skills_write"]');
  if (await checkbox.count()) await checkbox.setChecked(write);
  else smokeAssert(!write, "oauth_write_choice_missing");
  const callback = page.waitForRequest((request) => {
    const requestUrl = new URL(request.url());
    return requestUrl.origin === redirect.origin && requestUrl.pathname === redirect.pathname && requestUrl.searchParams.has("code");
  }, { timeout: 30_000 });
  await page.getByRole("button", { name: "Approve" }).click({ noWaitAfter: true });
  const called = new URL((await callback).url());
  smokeAssert(called.searchParams.get("state") === url.searchParams.get("state") &&
    called.searchParams.get("iss") === target.baseUrl, "oauth_callback_binding_invalid");
}

export async function oauth(command: string, args: string[], client: Client, page: Page,
  target: SkillsAgentsSmokeTarget, write = true) {
  // Native OAuth completion pages may close their tab. Each login owns a fresh
  // tab while retaining the synthetic browser session in its context.
  const consentPage = await page.context().newPage();
  const capturePath = join(client.configuration, "browser-url.txt");
  await writeFile(capturePath, "", { mode: 0o600 });
  // Claude requires a TTY even when it can open the browser and receive its
  // callback without manual input. Keep only this fixed native login in a PTY.
  const nativeClaude = command === "claude" && JSON.stringify(args) === JSON.stringify(["mcp", "login", "aiqsa_skills"]);
  const processHandle = spawnSmokeProcess(nativeClaude ? "script" : command,
    nativeClaude ? ["--quiet", "--return", "--command", "claude mcp login aiqsa_skills", "/dev/null"] : args,
    { cwd: client.directory, env: client.env });
  try {
    let authorizationUrl: string | null = null;
    const deadline = Date.now() + 60_000;
    while (!authorizationUrl && Date.now() < deadline) {
      const captured = await readFile(capturePath, "utf8").catch(() => "");
      authorizationUrl = findAuthorizationUrl(`${captured}\n${processHandle.output()}`, target.baseUrl);
      if (!authorizationUrl && processHandle.child.exitCode !== null) break;
      if (!authorizationUrl) await sleep(100);
    }
    smokeAssert(authorizationUrl, "oauth_authorization_url_missing");
    await approveOAuth(consentPage, authorizationUrl, target, write);
    const result = await processHandle.done;
    await writeFile(join(client.configuration, "oauth-private.log"), `${result.stdout}\n${result.stderr}`, { mode: 0o600 });
    smokeAssert(result.code === 0, "oauth_client_failed");
    emit("oauth", { client: client.kind, browserConsent: true, write });
  } finally {
    await writeFile(join(client.configuration, "oauth-private.log"), processHandle.output(), { mode: 0o600 });
    if (processHandle.child.exitCode === null) killSmokeProcess(processHandle.child);
    await processHandle.done.catch(() => undefined);
    await consentPage.close().catch(() => undefined);
  }
}

export async function prepareClient(kind: Client["kind"], target: SkillsAgentsSmokeTarget, reuse = false): Promise<Client | null> {
  const configuration = join(target.workRoot, `${kind}-config`);
  const directory = join(target.workRoot, `${kind}-workspace`);
  await mkdir(configuration, { mode: 0o700, recursive: reuse });
  await mkdir(directory, { mode: 0o700, recursive: reuse });
  const env = clientEnvironment();
  // HOME keeps its normal meaning for this child, but belongs to the disposable
  // client so native global Skill discovery cannot ingest operator packages.
  const isolatedUserHome = join(configuration, "user-home");
  await mkdir(isolatedUserHome, { mode: 0o700, recursive: reuse });
  env.HOME = isolatedUserHome;
  const isolatedRuntime = join(configuration, "runtime");
  await mkdir(isolatedRuntime, { mode: 0o700, recursive: reuse });
  env.XDG_RUNTIME_DIR = isolatedRuntime;
  env.TMPDIR = isolatedRuntime;
  const providerArgs: string[] = [];
  if (kind === "codex") {
    smokeAssert(process.env.CODEX_LB_API_KEY, "codex_provider_key_missing");
    const provider = codexLbOverridesFromConfig(await readFile(join(homedir(), ".codex/config.toml"), "utf8"));
    providerArgs.push(...provider.args);
    env.CODEX_LB_API_KEY = process.env.CODEX_LB_API_KEY;
    env.CODEX_HOME = configuration;
    if (!reuse) await writeFile(join(configuration, "config.toml"), 'mcp_oauth_credentials_store = "file"\n', { mode: 0o600 });
  } else {
    env.CLAUDE_CONFIG_DIR = configuration;
    const supplied = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const credentials = supplied ? null : await readFile(join(homedir(), ".claude/.credentials.json"), "utf8").catch(() => null);
    const oauthToken = supplied ?? (credentials ? (JSON.parse(credentials) as {
      claudeAiOauth?: { accessToken?: string }
    }).claudeAiOauth?.accessToken : undefined);
    if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    else if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    else { emit("client_skipped", { client: kind, code: "provider_credentials_unavailable" }); return null; }
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    await writeFile(join(configuration, "settings.json"), JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }), { mode: 0o600 });
  }
  const browserHelper = join(configuration, "open-browser.cjs");
  await writeFile(browserHelper, '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.AIQSA_SKILLS_BROWSER_CAPTURE, process.argv.slice(2).join(" ")+"\\n", {mode:0o600});\n', { mode: 0o700 });
  env.BROWSER = browserHelper;
  env.AIQSA_SKILLS_BROWSER_CAPTURE = join(configuration, "browser-url.txt");
  const result = await run(kind, ["--version"], { directory, env }, 20_000).catch(() => null);
  if (!result || result.code !== 0) {
    smokeAssert(kind === "claude", "codex_unavailable");
    emit("client_skipped", { client: kind, code: "executable_unavailable" });
    return null;
  }
  const version = result.stdout.match(/\d+\.\d+\.\d+/u)?.[0];
  smokeAssert(version, "client_version_invalid");
  emit("client", { client: kind, version });
  return { kind, directory, configuration, env, providerArgs, version };
}

export async function agent(client: Client, target: SkillsAgentsSmokeTarget, scenario: string, prompt: string,
  offline = false): Promise<ReturnType<typeof auditSkillsAgentEvents>> {
  const nativeSkillRoot = join(client.directory, client.kind === "codex" ? ".agents" : ".claude", "skills");
  await mkdir(nativeSkillRoot, { recursive: true, mode: 0o700 });
  const system = "This is an authorized isolated qualification workspace with synthetic fixtures. Work only within this workspace, the explicitly isolated native client configuration directory, and the named AIQSA installation. Never inspect personal home files, print credentials, read environment secrets, use other services, or change repository files. Use the transfer client's --state-dir within the current workspace for all its commands; never use its default home directory. Never execute downloaded skill code during installation. Perform the user's requested operations; report conflicts without silently overwriting them. Keep binary payloads and credentials out of conversational output.";
  const args = client.kind === "codex" ? [
    "--no-daemon", "exec", "--ephemeral", "--json", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
    "--sandbox", "workspace-write", "--cd", client.directory, "--add-dir", client.configuration, "--add-dir", nativeSkillRoot,
    "--model", target.codexModel ?? "gpt-6-sol", ...client.providerArgs,
    "-c", 'model_reasoning_effort="medium"', "-c", 'approval_policy="never"',
    "-c", 'mcp_oauth_credentials_store="file"',
    "-c", 'shell_environment_policy.inherit="none"',
    "-c", `shell_environment_policy.set.CODEX_HOME=${JSON.stringify(client.configuration)}`,
    "-c", `shell_environment_policy.set.HOME=${JSON.stringify(client.env.HOME)}`,
    "-c", `shell_environment_policy.set.PATH=${JSON.stringify(client.env.PATH ?? "/usr/bin:/bin")}`,
    "-c", `developer_instructions=${JSON.stringify(system)}`,
    "-c", `sandbox_workspace_write.network_access=${!offline}`,
    ...(offline || scenario === "setup" ? [] : ["-c", `mcp_servers.aiqsa_skills.url=${JSON.stringify(`${target.baseUrl}/mcp/skills`)}`,
      "-c", 'mcp_servers.aiqsa_skills.default_tools_approval_mode="approve"',
      "-c", 'mcp_servers.aiqsa_skills.startup_timeout_sec=60']), "-"
  ] : [
    "--print", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
    "--setting-sources", "", "--strict-mcp-config", "--mcp-config",
    offline || scenario === "setup" ? '{"mcpServers":{}}' : JSON.stringify({ mcpServers: { aiqsa_skills: { type: "http", url: `${target.baseUrl}/mcp/skills` } } }),
    "--model", target.claudeModel ?? "sonnet", "--effort", "medium", "--max-budget-usd", "8",
    "--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Write,Edit,Skill,mcp__aiqsa_skills__*",
    "--append-system-prompt", system
  ];
  const started = Date.now();
  const handle = spawnSmokeProcess(client.kind, args, { cwd: client.directory, env: client.env, timeoutMs: 480_000, stdin: prompt });
  const result = await handle.done.catch(async (error: unknown) => {
    await writeFile(join(client.configuration, `${scenario}.private.failure`), handle.output(), { mode: 0o600 });
    throw error;
  });
  await writeFile(join(client.configuration, `${scenario}.private.jsonl`), result.stdout, { mode: 0o600 });
  await writeFile(join(client.configuration, `${scenario}.private.stderr`), result.stderr, { mode: 0o600 });
  const audit = auditSkillsAgentEvents(result.stdout);
  emit("agent", { client: client.kind, scenario, exitCode: result.code, elapsedMs: Date.now() - started,
    tools: audit.tools, failedTools: audit.failedTools, invalidLines: audit.invalidLines });
  smokeAssert(result.code === 0, "agent_failed");
  smokeAssert(audit.invalidLines === 0, "agent_events_invalid");
  if (scenario.startsWith("download_install") || scenario.startsWith("upload")) {
    smokeAssert(audit.scriptExecutions === 0, "code_executed_during_transfer");
  }
  if (scenario.startsWith("native_use") || scenario.startsWith("native_after_revoke")) {
    smokeAssert(audit.scriptExecutions > 0, "native_skill_script_not_executed");
  }
  return audit;
}

async function seedUser(db: PrismaClient, target: SkillsAgentsSmokeTarget) {
  const userId = randomUUID();
  const email = `skills-${target.runId}-${randomBytes(4).toString("hex")}@example.invalid`;
  const password = `S1!${randomBytes(24).toString("hex")}`;
  const passwordHash = await hashPassword(password);
  await db.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email, displayName: "Skills qualification", role: "user", status: "active" } });
    await tx.authIdentity.create({ data: { userId, provider: "password", providerAccountId: email,
      normalizedEmail: email, emailVerifiedAt: new Date(), passwordHash } });
    await tx.userSettings.create({ data: { userId } });
  });
  return { userId, email, password };
}

export async function assertStoredPackage(db: PrismaClient, userId: string, expectedRevision: number) {
  const definitions = await db.skillDefinition.findMany({ where: { ownerUserId: userId, deletedAt: null },
    include: { currentRevision: { include: { files: true } }, publications: true } });
  smokeAssert(definitions.length === 1, "skill_count_invalid");
  const definition = definitions[0]!;
  const revision = definition.currentRevision;
  smokeAssert(revision?.bundleReady && revision.name === SMOKE_SKILL_NAME && definition.publications.length === 0,
    "stored_skill_not_ready_or_private");
  smokeAssert(revision.revisionNumber === expectedRevision, "stored_revision_invalid");
  const frontmatter = revision.frontmatterJson as { metadata?: Record<string, unknown> } | null;
  smokeAssert(frontmatter?.metadata?.["fixture-revision"] === String(expectedRevision), "frontmatter_not_preserved");
  const binary = revision.files.find((file) => file.path === "assets/template.bin");
  const script = revision.files.find((file) => file.path === "scripts/report.py");
  smokeAssert(binary?.byteSize === SMOKE_TEMPLATE.length && binary.checksum === smokeDigest(SMOKE_TEMPLATE) &&
    script?.checksum === smokeDigest(SMOKE_SCRIPT) && script.executable, "stored_manifest_invalid");
  return definition;
}

export async function revokeGrants(context: BrowserContext, db: PrismaClient, userId: string, baseUrl: string) {
  const grants = await db.inboundMcpOAuthGrant.findMany({ where: { userId, state: "ACTIVE" } });
  for (const grant of grants) {
    const response = await context.request.delete(`${baseUrl}/api/me/connected-apps/${encodeURIComponent(grant.id)}`,
      { headers: { origin: baseUrl } });
    smokeAssert(response.ok(), "grant_revoke_failed");
  }
  smokeAssert(await db.inboundMcpOAuthGrant.count({ where: { userId, state: "ACTIVE" } }) === 0, "grant_revoke_not_persisted");
  return grants.length;
}

export async function main(): Promise<void> {
  const targetPath = process.env.AIQSA_SKILLS_AGENTS_TARGET;
  smokeAssert(targetPath, "target_file_required");
  const file = await lstat(targetPath);
  smokeAssert(file.isFile() && !file.isSymbolicLink() && (file.mode & 0o077) === 0 && file.size < 16_384,
    "target_file_not_private");
  const target = parseSkillsAgentsSmokeTarget(JSON.parse(await readFile(targetPath, "utf8")), process.env.AIQSA_SKILLS_AGENTS_SMOKE);
  process.umask(0o077);
  await mkdir(target.workRoot, { mode: 0o700 });
  await chmod(target.workRoot, 0o700);
  privateFailurePath = join(target.workRoot, "harness.private.failure");
  const db = new PrismaClient({ datasources: { db: { url: target.databaseUrl } } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let userId: string | undefined;
  let completed = false;
  const clients: Client[] = [];
  try {
    const databaseName = await db.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    smokeAssert(databaseName[0]?.name === `aiqsa_skills_mcp_e2e_${target.runId}`, "database_identity_mismatch");
    const guideResponse = await fetch(`${target.baseUrl}/AGENTS.md`, { redirect: "error", signal: AbortSignal.timeout(60_000) });
    const guide = await guideResponse.text();
    smokeAssert(guideResponse.ok && /text\/markdown|text\/plain/u.test(guideResponse.headers.get("content-type") ?? "") &&
      guide.includes(`${target.baseUrl}/mcp/skills`) && guide.includes(`${target.baseUrl}/mcp/hub`), "public_guide_invalid");
    const alias = await fetch(`${target.baseUrl}/AGENTS`, { redirect: "manual" });
    smokeAssert([301, 302, 307, 308].includes(alias.status) &&
      new URL(alias.headers.get("location") ?? "", target.baseUrl).pathname === "/AGENTS.md", "public_alias_invalid");
    emit("discovery", { publicMarkdown: true, alias: true });
    const user = await seedUser(db, target);
    userId = user.userId;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const login = await context.request.post(`${target.baseUrl}/api/auth/login`, {
      data: { email: user.email, password: user.password }, headers: { origin: target.baseUrl }
    });
    smokeAssert(login.ok() && (await login.json() as { user?: { id: string } }).user?.id === userId, "browser_login_failed");
    const page = await context.newPage();
    for (const kind of ["codex", "claude"] as const) {
      const client = await prepareClient(kind, target);
      if (!client) continue;
      clients.push(client);
      // The real agent must discover and configure its native client from the public guide.
      await agent(client, target, "setup", `Connect my ${kind === "codex" ? "Codex" : "Claude Code"} to AIQSA using ${target.baseUrl}/AGENTS.md so I can upload and download my personal Skills. Name the connection aiqsa_skills. Fetch the guide and keep a local copy as AIQSA-CONNECT.md. Configure the connection, then stop before OAuth so I can complete browser sign-in. Do not connect Personal Memory or Hub.`);
      const fetchedGuide = await readFile(join(client.directory, "AIQSA-CONNECT.md"), "utf8");
      smokeAssert(fetchedGuide === guide, "agent_did_not_fetch_guide");
      // If the agent could not configure a child client, fail; don't substitute a successful setup.
      const configured = await run(kind, kind === "codex" ? ["mcp", "get", "aiqsa_skills", "--json"] : ["mcp", "get", "aiqsa_skills"], client, 60_000);
      smokeAssert(configured.code === 0 && configured.stdout.includes(`${target.baseUrl}/mcp/skills`), "agent_setup_missing");
      const grantsBefore = await db.inboundMcpOAuthGrant.findMany({ where: { userId }, select: { id: true } });
      await oauth(kind, kind === "codex" ? ["mcp", "login", "aiqsa_skills", "--scopes", "skills:read,skills:write", "--oauth-client-registration", "auto"]
        : ["mcp", "login", "aiqsa_skills"], client, page, target);
      const grantsAfter = await db.inboundMcpOAuthGrant.findMany({ where: { userId, state: "ACTIVE", resourcePath: "/mcp/skills" } });
      const nativeGrant = grantsAfter.filter((grant) => !grantsBefore.some((old) => old.id === grant.id));
      smokeAssert(nativeGrant.length === 1, "native_grant_identity_ambiguous");
      client.grantId = nativeGrant[0]!.id;
      smokeAssert(nativeGrant[0]!.scopes.includes("skills:write"), "native_write_consent_missing");
      const refreshedBefore = await db.inboundMcpOAuthToken.count({ where: { kind: "REFRESH", consumedAt: { not: null }, family: { grantId: client.grantId } } });
      await db.inboundMcpOAuthToken.updateMany({ where: { kind: "ACCESS", family: { grantId: client.grantId } }, data: { expiresAt: new Date(Date.now() + 1_000) } });
      await sleep(1_200);
      const refreshedAudit = await agent(client, target, "refresh", "List my personal Skills in AIQSA. An empty library is expected and is a successful result.");
      smokeAssert(refreshedAudit.tools.includes("list_skills") && refreshedAudit.failedTools === 0, "native_list_not_successful");
      smokeAssert(await db.inboundMcpOAuthToken.count({ where: { kind: "REFRESH", consumedAt: { not: null }, family: { grantId: client.grantId } } }) > refreshedBefore,
        "native_refresh_not_observed");
      emit("refresh_oracle", { client: kind, consumedRefresh: true, guideFetchedByAgent: true, nativeSetupByAgent: true });
      if (kind === "codex") await createSmokeSkill(join(client.directory, "source", SMOKE_SKILL_NAME));
      await writeFile(join(client.directory, "inventory.csv"), "name,quantity,unit_cents\nA,3,250\nB,2,600\nC,1,120\n", { mode: 0o600 });
    }
    smokeAssert(clients[0]?.kind === "codex", "codex_qualification_required");
    // Transfer client preparation/authentication is intentionally driven by the
    // guide in the live scenario; its exact invocation is resolved at runtime.
    const source = clients[0]!;
    await agent(source, target, "upload", `Upload my local Skill source/${SMOKE_SKILL_NAME} as a new personal Skill in AIQSA, keeping every file and executable flag. Use /mcp/skills for discovery/create and the transfer procedure from AIQSA-CONNECT.md for bytes. Use operation key smoke_create_${target.runId}. Do not execute the Skill yet. If transfer OAuth is needed, prepare its command in transfer-login.json as a JSON argv array and stop without blocking, otherwise finish the upload.`);
    // The stand orchestrator can approve any extra transfer-client OAuth after
    // this explicit boundary; never borrow native-client secrets.
    const loginCommand = await readFile(join(source.directory, "transfer-login.json"), "utf8").catch(() => null);
    if (loginCommand) {
      const argv = JSON.parse(loginCommand) as unknown;
      smokeAssert(Array.isArray(argv) && argv.length > 1 && argv.every((part) => typeof part === "string"), "transfer_login_command_invalid");
      smokeAssert(["node", "npx", "npm"].includes(argv[0] as string), "transfer_login_executable_invalid");
      await oauth(argv[0] as string, argv.slice(1) as string[], source, page, target, argv.includes("--write"));
      await rm(join(source.directory, "transfer-login.json"));
      await agent(source, target, "upload_authorized", `Transfer OAuth is complete. Finish the previously requested full upload of source/${SMOKE_SKILL_NAME}, reusing operation key smoke_create_${target.runId}. Keep all files. Do not create a second Skill or execute scripts.`);
    }
    const first = await assertStoredPackage(db, userId, 1);
    const firstVersion = first.version;
    const receiptsBefore = await db.skillStoreOperation.count({ where: { ownerUserId: userId } });
    await agent(source, target, "upload_retry", `Repeat the exact upload request for source/${SMOKE_SKILL_NAME} using the same operation key smoke_create_${target.runId}; the previous response might have been lost. It must recover the original result, not create another Skill.`);
    await assertStoredPackage(db, userId, 1);
    smokeAssert(await db.skillStoreOperation.count({ where: { ownerUserId: userId } }) === receiptsBefore, "duplicate_receipt");
    emit("upload_oracle", { fullPackage: true, private: true, duplicateFree: true });

    for (const client of clients) {
      const native = client.kind === "codex" ? ".agents/skills" : ".claude/skills";
      await agent(client, target, "download_install", `Download my AIQSA Skill ${first.id} and install the complete package in this project's ${native}/${SMOKE_SKILL_NAME}. Use the public guide's transfer client, verify the manifest, and preserve executable flags. Do not copy source/ and do not run scripts during installation. If transfer OAuth is needed, write its argv array to transfer-login.json and stop.`);
      const transferLogin = await readFile(join(client.directory, "transfer-login.json"), "utf8").catch(() => null);
      if (transferLogin) {
        const argv = JSON.parse(transferLogin) as string[];
        smokeAssert(Array.isArray(argv) && argv.length > 1 && ["node", "npx", "npm"].includes(argv[0]!), "transfer_login_command_invalid");
        await oauth(argv[0]!, argv.slice(1), client, page, target, argv.includes("--write"));
        await rm(join(client.directory, "transfer-login.json"));
        await agent(client, target, "download_install_authorized", `Transfer OAuth is complete. Finish downloading Skill ${first.id} into ${native}/${SMOKE_SKILL_NAME}. Preserve all package bytes and executable flags. Do not run the Skill yet.`);
      }
      await assertSmokeInstalledPackage(join(client.directory, native, SMOKE_SKILL_NAME));
      await agent(client, target, "native_use", `${client.kind === "codex" ? "$" : "/"}${SMOKE_SKILL_NAME} Use this installed Skill to make inventory-report.json from inventory.csv.`, true);
      await assertSmokeNativeReport(join(client.directory, "inventory-report.json"));
      emit("native_oracle", { client: client.kind, binaryExact: true, executable: true, usefulArtifact: true, mcpDisabled: true });
    }

    await writeFile(join(source.directory, "source", SMOKE_SKILL_NAME, "SKILL.md"), smokeSkillMarkdown(2));
    await agent(source, target, "update", `Sync my edited source/${SMOKE_SKILL_NAME} package to the existing AIQSA Skill ${first.id} at version ${firstVersion}. Use operation key smoke_update_${target.runId}. Keep the same Skill identity, complete bundle and library settings; do not delete anything.`);
    const updated = await assertStoredPackage(db, userId, 2);
    smokeAssert(updated.id === first.id && updated.version > firstVersion, "update_identity_invalid");
    await agent(source, target, "conflict", `Try updating AIQSA Skill ${first.id} with source/${SMOKE_SKILL_NAME}, expectedVersion ${firstVersion} and operation key smoke_stale_${target.runId}. This simulates a stale local copy. Report the conflict and leave both sides unchanged; do not retry with a newer version.`);
    const afterConflict = await assertStoredPackage(db, userId, 2);
    smokeAssert(afterConflict.version === updated.version, "conflict_overwrote_skill");
    const installedMarkdown = join(source.directory, ".agents/skills", SMOKE_SKILL_NAME, "SKILL.md");
    const localEdit = `${await readFile(installedMarkdown, "utf8")}\nLocal-only instruction: keep pending inventory notes in the report workspace.\n`;
    await writeFile(installedMarkdown, localEdit);
    await agent(source, target, "bidirectional_conflict", `Sync my installed .agents/skills/${SMOKE_SKILL_NAME} with its AIQSA Skill ${first.id}. Both the local package and the AIQSA package have changed since installation. Compare provenance and contents. Do not pick a winner for a two-sided conflict; report it and preserve both versions. Absence of another package on either side is not a deletion instruction.`);
    smokeAssert((await readFile(installedMarkdown, "utf8")) === localEdit, "sync_overwrote_local_conflict");
    const afterSyncConflict = await assertStoredPackage(db, userId, 2);
    smokeAssert(afterSyncConflict.version === updated.version, "sync_overwrote_remote_conflict");
    await agent(source, target, "delete", `Use the native MCP delete_skill tool to delete my AIQSA Skill ${first.id} at expectedVersion ${updated.version}; use operation key smoke_delete_${target.runId}. Delete only this remote Skill. Preserve installed local copies. Keep the same native MCP client for any replay.`);
    const deleted = await db.skillDefinition.findUniqueOrThrow({ where: { id: first.id } });
    smokeAssert(deleted.deletedAt, "delete_not_persisted");
    const deleteReceipts = await db.skillStoreOperation.count({ where: { ownerUserId: userId } });
    const deleteReplay = await agent(source, target, "delete_retry", `Use the same native MCP delete_skill tool to repeat my exact delete request for AIQSA Skill ${first.id} with expectedVersion ${updated.version} and operation key smoke_delete_${target.runId}; recover the prior result without another mutation. Do not switch to the transfer helper: operation receipts belong to the client that made the original request.`);
    smokeAssert(deleteReplay.tools.includes("delete_skill") && deleteReplay.failedTools === 0, "delete_receipt_not_recovered");
    smokeAssert((await db.skillDefinition.findUniqueOrThrow({ where: { id: first.id } })).version === deleted.version &&
      await db.skillStoreOperation.count({ where: { ownerUserId: userId } }) === deleteReceipts, "delete_replay_changed_state");
    smokeAssert(await db.chat.count({ where: { userId } }) === 0, "synthetic_chat_created");
    emit("mutation_oracle", { versionGuard: true, bidirectionalConflictPreserved: true, explicitDelete: true, noChatArtifacts: true });
    const revoked = await revokeGrants(context, db, userId, target.baseUrl);
    for (const client of clients) {
      await agent(client, target, "revoked", "List my Skills in AIQSA. Access has just been revoked; report the authorization problem and do not attempt a fresh login.");
      await rm(join(client.directory, "inventory-report.json"));
      await agent(client, target, "native_after_revoke", `${client.kind === "codex" ? "$" : "/"}${SMOKE_SKILL_NAME} Rebuild inventory-report.json from inventory.csv using the already installed local Skill.`, true);
      await assertSmokeNativeReport(join(client.directory, "inventory-report.json"));
    }
    smokeAssert(await db.inboundMcpOAuthGrant.count({ where: { userId, state: "ACTIVE" } }) === 0, "revoked_client_reauthorized");
    emit("revocation_oracle", { revokedGrants: revoked, installedSkillsRemainUsable: true });
    completed = true;
  } finally {
    await browser?.close();
    if (userId) {
      await db.inboundMcpOAuthGrant.updateMany({ where: { userId, state: "ACTIVE" }, data: { state: "REVOKED", revokedAt: new Date(), revision: { increment: 1 } } });
      await db.user.update({ where: { id: userId }, data: { status: "disabled" } });
    }
    await db.$disconnect();
    if (completed) await rm(target.workRoot, { recursive: true, force: true });
    emit("cleanup", { grantsRevoked: Boolean(userId), syntheticUserDisabled: Boolean(userId), isolatedClientsRemoved: completed,
      diagnosticsRetainedPrivately: !completed, databaseOwnedByStand: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(async (error: unknown) => {
    if (privateFailurePath) await writeFile(privateFailurePath, error instanceof Error ? error.stack ?? error.name : "Unknown failure", { mode: 0o600 });
    const code = error instanceof Error && /^skills_agents_[a-z_]+$/u.test(error.message)
      ? error.message : "skills_agents_unexpected_failure";
    emit("failed", { code });
    process.exitCode = 1;
  });
}
