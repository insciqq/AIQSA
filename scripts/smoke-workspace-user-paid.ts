import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { chromium, expect, type APIResponse } from "@playwright/test";
import {
  artifactOracle, codexLbRoute, csvInput, pricingInput, pricingTests,
  requirePaidStand, scheduleInput, scheduleRules, type PaidStand
} from "./workspace-user-paid-support";
import { runOfficeUserScenarios, type OfficeInput } from "./workspace-user-paid-office";

// Explicit opt-in, never a default Playwright/Vitest lane. Requires a fresh
// task-owned Compose JSON, seeded DB, running dev app/runner/maintenance and
// the operator's existing codex-lb profile/key. No .env loading or trace files.
let stage = "guard";
let step = "guard";
function emit(value: Record<string, unknown>) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function requireValue(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`workspace_user_paid_${code}`);
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function json(response: APIResponse) {
  requireValue(response.ok(), `http_${response.status()}`);
  return response.json();
}

async function poll<T>(operation: () => Promise<T>, accepts: (value: T) => boolean, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await operation();
    if (accepts(value)) return value;
    await wait(1_000);
  } while (Date.now() < deadline);
  throw new Error("workspace_user_paid_poll_timeout");
}

async function main() {
  const composeFile = process.env.AIQSA_WORKSPACE_USER_PAID_COMPOSE_FILE;
  requireValue(composeFile, "compose_required");
  const stand = JSON.parse(readFileSync(composeFile, "utf8")) as PaidStand;
  const target = requirePaidStand(process.env.AIQSA_WORKSPACE_USER_PAID_E2E, stand);
  const route = codexLbRoute(readFileSync(join(homedir(), ".codex", "config.toml"), "utf8"));
  const scenario = process.env.AIQSA_WORKSPACE_USER_PAID_SCENARIO ?? "ALL";
  requireValue(["ALL", "CSV", "CODE", "SCHEDULE", "OFFICE"].includes(scenario), "scenario_invalid");
  const officeSelected = scenario === "ALL" || scenario === "OFFICE";
  const officeCase = process.env.AIQSA_WORKSPACE_USER_PAID_OFFICE_CASE ?? "ALL";
  requireValue(["ALL", "STOCK", "PRESENTATION", "DOCX", "MONTHLY"].includes(officeCase), "office_case_invalid");
  // Build this existing pinned Dockerfile stage once; it adds no app dependency:
  // docker build --target workspace-guest -t aiqsa-workspace-office-check:local .
  const officeImage = process.env.AIQSA_WORKSPACE_USER_PAID_OFFICE_IMAGE ?? "aiqsa-workspace-office-check:local";
  const officeOracle = officeSelected ? readFileSync(new URL("./workspace-office-artifacts.py", import.meta.url), "utf8") : "";
  const secret = process.env.CODEX_LB_API_KEY;
  requireValue(secret, "codex_lb_key_required");
  const docker = (args: string[], input?: string) => execFileSync("docker", args,
    { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
  const compose = (...args: string[]) => docker(["compose", "--env-file", "/dev/null", "-p", target.project, "-f", composeFile, "--profile", "workspace-live", ...args]);
  const roles = ["app", "postgres", "workspace-runner", "workspace-maintenance",
    ...(stand.services["memory-worker"] ? ["memory-worker"] : []),
    ...(stand.services["browser-tls"] ? ["browser-tls"] : [])];
  let oracleImage = "";
  for (const role of roles) {
    const id = compose("ps", "-q", role).trim();
    requireValue(id, "role_missing");
    const info = JSON.parse(docker(["inspect", id]))[0];
    requireValue(info.Config.Labels["com.docker.compose.project"] === target.project && info.State.Running && !info.State.OOMKilled, "role_not_ready");
    if (role !== "postgres" && role !== "browser-tls") {
      const actual = Object.fromEntries((info.Config.Env as string[]).map(entry => {
        const separator = entry.indexOf("="); return [entry.slice(0, separator), entry.slice(separator + 1)];
      }));
      for (const key of ["AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME", "AIQSA_WORKSPACE_MEMORY_MIB", "AIQSA_WORKSPACE_CPUS", "AIQSA_WORKSPACE_MAX_TOOL_ROUNDS", "AIQSA_WORKSPACE_MAX_TOOL_CALLS", "AIQSA_WORKSPACE_TURN_TIMEOUT_SECONDS"]) {
        requireValue(actual[key] === stand.services[role].environment[key], "running_role_bounds_mismatch");
      }
    }
    if (role === "app") oracleImage = info.Image;
  }
  const guestCount = () => {
    const value = JSON.parse(compose("exec", "-T", "workspace-runner", "node", "-e",
      'const {Sandbox}=require("microsandbox");Sandbox.list({limit:100}).then(r=>console.log(JSON.stringify({count:r.sandboxes.length,more:!!r.nextCursor})));'));
    requireValue(!value.more, "guest_inventory_overflow");
    return Number(value.count);
  };
  requireValue(guestCount() === 0, "fresh_runner_required");
  docker(["run", "--rm", "--network", "none", "--memory", "128m", "--read-only", "--entrypoint", "python3", oracleImage, "-I", "-c", "import csv,json,decimal"]);
  if (officeSelected) docker(["run", "--rm", "--network", "none", "--memory", "256m", "--read-only", "--entrypoint", "python3", officeImage, "-I", "-c", "import openpyxl,docx,pptx"]);
  const db = new PrismaClient({ datasources: { db: { url: target.databaseUrl } } });
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: target.baseUrl, acceptDownloads: true,
    // Only the guarded disposable loopback proxy uses a task-local certificate.
    ignoreHTTPSErrors: target.baseUrl.startsWith("https:") });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const ownedChats: string[] = [];
  const started = new Date();
  let cleanupComplete = false;
  let minimumAvailableMiB = Infinity;
  let completedScenarios = 0;
  let answerTurns = 0;
  const artifactRoot = officeSelected ? mkdtempSync(join(tmpdir(), "aiqsa-office-paid-artifacts-")) : null;
  const memory = () => {
    const available = Number(/MemAvailable:\s+(\d+)/u.exec(readFileSync("/proc/meminfo", "utf8"))?.[1]) / 1024;
    requireValue(Number.isFinite(available) && available >= 2048, "insufficient_memory");
    minimumAvailableMiB = Math.min(minimumAvailableMiB, Math.floor(available));
  };
  const oracle = (caseName: string, files: Map<string, Buffer>) => {
    const office = caseName.startsWith("office_");
    if (office && artifactRoot) {
      const directory = join(artifactRoot, caseName);
      mkdirSync(directory, { mode: 0o700 });
      for (const [fileName, bytes] of files) {
        requireValue(/^[a-z0-9.-]+$/iu.test(fileName), "artifact_name_invalid");
        writeFileSync(join(directory, fileName), bytes, { mode: 0o600 });
      }
    }
    const name = `${target.project}-oracle-${randomBytes(4).toString("hex")}`;
    try {
      const memory = office ? "256m" : "128m";
      const result = JSON.parse(docker(["run", "--rm", "--name", name, "--network", "none", "--memory", memory, "--memory-swap", memory, "--cpus", "1", "--pids-limit", "32", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65534:65534", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--entrypoint", "python3", "-i", office ? officeImage : oracleImage, "-I", "-c", office ? officeOracle : artifactOracle],
        JSON.stringify({ case: caseName, files: Object.fromEntries([...files].map(([name, bytes]) => [name, bytes.toString("base64")])) })));
      requireValue(result.oraclePassed === true, "artifact_oracle_failed");
    } catch {
      throw new Error(`workspace_user_paid_${caseName}_artifact_check_failed`);
    } finally {
      // The exact unique name is owned even if timeout killed the Docker client.
      try { docker(["rm", "-f", name]); } catch { /* --rm already removed it */ }
    }
  };
  async function deleteChat(chatId: string) {
    step = "delete_chat";
    await json(await page.request.post(`/api/chats/${chatId}/delete-permanently`, { data: {
      alsoForgetOriginMemories: true, confirmationCopyVersion: "memory-confirmation-v1", requestId: randomUUID()
    } }));
    await poll(() => db.chat.count({ where: { id: chatId } }), (count) => count === 0);
    requireValue(guestCount() === 0, "guest_cleanup_failed");
  }
  try {
    memory();
    requireValue(await db.modelRun.count() === 0, "fresh_database_required");
    if (stand.services.app.environment.NODE_ENV === "production") {
      requireValue(await db.memoryWorkerHeartbeat.count({
        where: { lastSeenAt: { gte: new Date(Date.now() - 60_000) } }
      }) > 0, "deletion_worker_not_ready");
    }
    stage = "setup";
    const bootstrapToken = stand.services.app.environment.AIQSA_BOOTSTRAP_AUTH_TOKEN ?? "aiqsa-test-token";
    await json(await page.request.post("/api/auth/token", { data: { token: bootstrapToken } }));
    // Disable optional utility destinations through their normal Admin/user
    // contracts so this Workspace qualification cannot invoke a seeded fake.
    const system = await json(await page.request.get("/api/admin/providers/system-model-policy"));
    await json(await page.request.patch("/api/admin/providers/system-model-policy", { data: {
      expectedVersion: system.systemModelPolicy.policy.version, providerModelId: null, reasoningEffort: null, rerankerProviderModelId: null
    } }));
    await json(await page.request.patch("/api/me/memory/settings", { data: {
      useMemoryFacts: false, referenceChatHistory: false, learnAutomatically: false, synthesisEnabled: false, decayEnabled: false
    } }));
    const workspace = await json(await page.request.get("/api/admin/workspace"));
    await json(await page.request.patch("/api/admin/workspace", { data: {
      expectedVersion: workspace.workspace.version ?? workspace.workspace.policy.version, enabled: true, internetEnabled: false
    } }));
    // Reuse this stand's already tested exact tuple after a diagnosed harness
    // failure; UI retries must not repeat paid compatibility probes.
    stage = "provider_setup";
    const catalog = await json(await page.request.get("/api/me/catalog"));
    const existing = catalog.catalog.models.filter((model: { displayName: string; upstreamModelId: string }) =>
      model.displayName === "Workspace real model" && model.upstreamModelId === route.model);
    requireValue(existing.length <= 1, "provider_ambiguous");
    let provider;
    if (existing.length === 1) {
      const model = await db.providerModel.findUniqueOrThrow({ where: { id: existing[0].modelId }, include: {
        connection: { include: { credentials: { where: { enabled: true }, select: { id: true, activeVersionId: true } } } }
      } });
      const connection = model.connection;
      const credential = connection.credentials[0];
      const configuration = model.activeConfig as { adapterKind?: string; capabilities?: { contextWindow?: number; defaultMaxOutputTokens?: number } } | null;
      requireValue(connection.family === "openai_compatible" &&
        (connection.activeConfig as { apiRoot?: string } | null)?.apiRoot === route.apiRoot &&
        configuration?.adapterKind === "openai_responses_compatible" &&
        configuration.capabilities?.contextWindow === 65_536 && configuration.capabilities.defaultMaxOutputTokens === 4096 &&
        connection.credentials.length === 1 && credential?.activeVersionId, "provider_reuse_mismatch");
      requireValue(await db.providerModelCredentialCheck.count({ where: {
        connectionId: connection.id, providerModelId: model.id, connectionVersion: connection.activeVersion,
        modelVersion: model.activeVersion, credentialVersionId: credential.activeVersionId,
        status: "available"
      } }) === 1, "provider_reuse_evidence_missing");
      provider = { connectionId: connection.id, providerModelId: model.id, modelDisplayName: model.displayName };
    } else {
      // Ordinary Admin setup supplies real bounded compatibility evidence.
      provider = await json(await page.request.post("/api/admin/providers/custom-setup", { timeout: 900_000, data: {
        allowPrivateNetwork: true, apiRoot: route.apiRoot, authenticationMode: "bearer", secret,
        protocol: "responses", confirmPaidRequest: true, modelId: route.model,
        connectionDisplayName: "Workspace codex-lb qualification", modelDisplayName: "Workspace real model",
        responseTimeoutSeconds: 180,
        capabilities: { contextWindow: 65_536, defaultMaxOutputTokens: 4096, streaming: true, toolCalling: true,
          parallelToolCalls: false, reasoning: true, reasoningEfforts: ["low"], defaultReasoningEffort: "low",
          nativePdfInput: false, nativeImageGeneration: false, nativeSearch: false, pdf: true, vision: false }
      } }));
      requireValue(provider.outcome === "ready", "provider_setup_failed");
    }
    emit({ stage: "provider_ready", provider: "codex-lb", model: route.model, realCompatibilityChecks: true, reused: existing.length === 1 });

    const waitForAttachment = async (name: string, workspace: boolean) => {
      const row = page.getByRole("region", { name: "Attachments" }).getByRole("listitem").filter({ hasText: name });
      const ready = row.getByText("Ready", { exact: true });
      // Optional text extraction may be unavailable while the original bytes
      // are already admitted for Workspace. Other failed uploads still fail.
      await expect(workspace ? ready.or(row.getByText(/Workspace can use the stored original/u)) : ready)
        .toBeVisible({ timeout: 90_000 });
    };
    const newChat = async (files: OfficeInput[], enableWorkspace = true) => {
      memory();
      requireValue(guestCount() === 0, "parallel_guest_forbidden");
      step = "new_chat";
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 90_000 });
      await page.getByRole("complementary", { name: "Chat navigation" }).getByRole("button", { name: "New chat", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
      step = "model_selection";
      await page.getByTestId("header-model-trigger").click();
      const picker = page.getByRole("dialog", { name: "Choose model" });
      await picker.getByRole("searchbox", { name: "Search models" }).fill(provider.modelDisplayName);
      await picker.locator(`[role="option"][data-provider-id="${provider.connectionId}"]`).filter({ hasText: provider.modelDisplayName }).click();
      await expect(picker).toHaveCount(0);
      step = "workspace_toggle";
      if (enableWorkspace) {
        await page.getByRole("button", { name: /^Turn on Workspace/u }).click();
        await expect(page.getByRole("button", { name: /^Turn off Workspace/u })).toBeVisible();
      } else {
        await expect(page.getByRole("button", { name: /^Turn on Workspace/u })).toBeVisible();
      }
      await expect(page.getByRole("button", { name: "Turn off Search" })).toHaveCount(0);
      step = "upload";
      if (files.length) await page.getByLabel("Attach files").setInputFiles(files.map(file => ({ name: file.name, mimeType: file.mimeType, buffer: file.buffer ?? Buffer.from(file.text ?? "") })));
      for (const file of files) await waitForAttachment(file.name, enableWorkspace);
      const chatId = await page.evaluate(() => localStorage.getItem("aiqsa.activeChatId"));
      if (chatId) {
        requireValue(/^[0-9a-f-]{36}$/u.test(chatId), "chat_identity_missing");
        ownedChats.push(chatId);
      }
      return chatId;
    };
    const send = async (existingChatId: string | null, prompt: string, clarification = false) => {
      step = "answer";
      const before = existingChatId ? await db.modelRun.count({ where: { chatId: existingChatId } }) : 0;
      const composer = page.getByRole("textbox", { name: "Message" });
      await composer.fill(prompt);
      await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
      const admitted = page.waitForResponse(r => r.request().method() === "POST" &&
        /\/api\/chats\/[0-9a-f-]{36}\/messages$/u.test(new URL(r.url()).pathname));
      await composer.press("Enter");
      const response = await admitted;
      const chatId = new URL(response.url()).pathname.split("/")[3]!;
      requireValue(!existingChatId || chatId === existingChatId, "chat_identity_changed");
      if (!ownedChats.includes(chatId)) ownedChats.push(chatId);
      requireValue(response.ok(), "admission_failed");
      const run = await poll(() => db.modelRun.findFirst({ where: { chatId }, orderBy: { createdAt: "desc" } }), r => !!r && !["preparing", "queued", "streaming", "in_progress"].includes(r.status), 660_000);
      requireValue(run?.status === "complete", "answer_not_complete");
      requireValue(await db.modelRun.count({ where: { chatId } }) === before + 1, "duplicate_run");
      await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 45_000 });
      await poll(() => db.workspaceRunBinding.findUnique({ where: { modelRunId: run.id } }), b => b?.exportState === "COMPLETE");
      const session = await poll(() => db.workspaceSession.findUnique({ where: { chatId } }), s => !!s && s.operationOwner === null);
      const binding = await db.providerRunBinding.findFirstOrThrow({ where: { modelRunId: run.id, bindingKey: "answer" } });
      requireValue(binding.connectionId === provider.connectionId && binding.providerModelId === provider.providerModelId && run.provider !== "fake", "provider_identity_mismatch");
      const calls = await db.modelRunToolCall.findMany({ select: { toolName: true, state: true }, where: { modelRunId: run.id } });
      requireValue((clarification || calls.length > 0) && calls.length <= 30 && calls.every(call => call.toolName.startsWith("mcp_workspace_")), "workspace_tool_bounds");
      if (!clarification) requireValue(calls.some(call => call.state === "complete" && /sandbox_(shell|exec)/u.test(call.toolName)), "real_execution_missing");
      requireValue(await db.memoryRetrievalAttempt.count({ where: { outcome: "DEGRADED" } }) === 0, "memory_degraded");
      if (calls.length) await expect(page.locator('article[data-role="assistant"]').last().getByTestId("tool-activity-disclosure")).toBeVisible();
      memory();
      emit({ stage: "answer_complete", case: stage, toolCalls: calls.length, codexLbVerified: true, memoryDegraded: 0 });
      answerTurns += 1;
      return { chatId, run, session };
    };
    const downloads = async (runId: string, names: string[]) => {
      step = "download";
      requireValue(await db.workspaceRunOutput.count({ where: { workspaceRunBindingId: runId } }) === names.length, "output_count_mismatch");
      const answer = page.locator('article[data-role="assistant"]').last();
      const region = answer.getByRole("region", { name: "Generated files" });
      const files = new Map<string, Buffer>();
      for (const name of names) {
        const row = region.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
        await expect(row).toBeVisible({ timeout: 90_000 });
        const pending = page.waitForEvent("download");
        await row.getByRole("link", { name: "Download", exact: true }).click();
        const download = await pending;
        requireValue(download.suggestedFilename() === name, "download_name_mismatch");
        const stream = await download.createReadStream();
        requireValue(stream, "download_missing");
        const parts: Buffer[] = []; let size = 0;
        for await (const part of stream) { size += part.length; requireValue(size <= 2 * 1024 * 1024, "download_limit"); parts.push(Buffer.from(part)); }
        const bytes = Buffer.concat(parts);
        const output = await db.workspaceRunOutput.findFirstOrThrow({ where: { workspaceRunBindingId: runId, relativePath: name } });
        requireValue(bytes.length === output.byteSize && sha(bytes) === output.checksum, "download_checksum_mismatch");
        files.set(name, bytes);
      }
      return files;
    };
    const originals = async (chatId: string, expected: string[]) => {
      const rows = await db.attachment.findMany({ select: { id: true, checksum: true }, where: { chatId, origin: "USER_UPLOAD" } });
      requireValue(rows.length === expected.length, "original_count_mismatch");
      const hashes: string[] = [];
      for (const row of rows) {
        const response = await page.request.get(`/api/attachments/${row.id}/content`);
        requireValue(response.ok(), "original_unavailable");
        const hash = sha(await response.body()); requireValue(hash === row.checksum, "original_changed"); hashes.push(hash);
      }
      requireValue(JSON.stringify(hashes.sort()) === JSON.stringify(expected.map(text => sha(Buffer.from(text))).sort()), "original_bytes_mismatch");
    };

    if (scenario === "ALL" || scenario === "CSV") {
      stage = "csv";
      const csvChat = await newChat([{ name: "invoices.csv", mimeType: "text/csv", text: csvInput }]);
      const csv = await send(csvChat, "Please reconcile the uploaded invoices using Python in Workspace. Keep paid rows only, trim region whitespace, keep the first occurrence of each invoice_id, and sort by invoice_id. Use exact decimal money. Produce cleaned.csv with invoice_id,region,amount; summary.json with invoice_count, total and by_region (region to amount); and a short report.md explaining exclusions and totals. Execute your code and provide downloadable files. Use only the standard library and give a brief final answer.");
      const csvFiles = await downloads(csv.run.id, ["cleaned.csv", "summary.json", "report.md"]);
      oracle("csv", csvFiles); await originals(csv.chatId, [csvInput]); await deleteChat(csv.chatId);
      emit({ stage: "scenario_passed", case: "csv", artifacts: csvFiles.size, checksums: [...csvFiles.values()].map(sha) });
      completedScenarios += 1;
    }

    if (scenario === "ALL" || scenario === "CODE") {
      stage = "code";
      const codeChat = await newChat([{ name: "pricing.py", mimeType: "text/x-python", text: pricingInput }, { name: "test_pricing.py", mimeType: "text/x-python", text: pricingTests }]);
      const code = await send(codeChat, "Please repair the uploaded pricing.py, leaving the supplied tests unchanged. invoice_total(items, tax_percent) must calculate with Decimal, round the final total using ROUND_HALF_UP, return a string with exactly two decimal places, and reject negative quantities or prices with ValueError. Work in Workspace, run the uploaded unittest suite and preserve its real stdout/stderr in test-results.txt. Provide the fixed pricing.py and test-results.txt as downloads. Use only the standard library and keep the final answer brief.");
      const codeFiles = await downloads(code.run.id, ["pricing.py", "test-results.txt"]);
      oracle("code", codeFiles); await originals(code.chatId, [pricingInput, pricingTests]); await deleteChat(code.chatId);
      emit({ stage: "scenario_passed", case: "code", artifacts: codeFiles.size, checksums: [...codeFiles.values()].map(sha), independentExecution: true });
      completedScenarios += 1;
    }

    if (scenario === "ALL" || scenario === "SCHEDULE") {
      stage = "schedule";
      const scheduleChat = await newChat([{ name: "schedule.json", mimeType: "application/json", text: scheduleInput }, { name: "requirements.md", mimeType: "text/markdown", text: scheduleRules }]);
      const first = await send(scheduleChat, "Please turn the uploaded workshop schedule and requirements into agenda.csv and calendar.ics for participants. Use and execute a reusable Python generator in Workspace, keep the generator and source data in the project for later edits, and provide both outputs as downloads. Follow the uploaded column, UTC and UID requirements. Use only the standard library and keep your final answer brief.");
      const initialFiles = await downloads(first.run.id, ["agenda.csv", "calendar.ics"]);
      oracle("schedule", initialFiles);
      await page.reload(); await expect(page.getByTestId("app-shell")).toBeVisible();
      stage = "schedule_revised";
      const revised = await send(first.chatId, "The Data practice session S2 now starts 90 minutes later, with its duration unchanged. Please update the generator/data saved in this Workspace and regenerate downloads as agenda-v2.csv and calendar-v2.ics. Keep every other session unchanged and preserve the earlier downloadable versions. I have not uploaded anything else. Run the generator and keep the final answer brief.");
      const revisedFiles = await downloads(revised.run.id, ["agenda-v2.csv", "calendar-v2.ics"]);
      oracle("schedule_revised", revisedFiles);
      requireValue(first.session?.runtimeSandboxId && first.session.runtimeSandboxId === revised.session?.runtimeSandboxId, "followup_disk_changed");
      await originals(first.chatId, [scheduleInput, scheduleRules]);
      for (const [name, bytes] of initialFiles) {
        const output = await db.workspaceRunOutput.findFirstOrThrow({ where: { workspaceRunBindingId: first.run.id, relativePath: name } });
        const response = await page.request.get(`/api/attachments/${output.attachmentId}/content`);
        requireValue(response.ok() && sha(await response.body()) === sha(bytes), "prior_output_changed");
      }
      await deleteChat(first.chatId);
      emit({ stage: "scenario_passed", case: "schedule", artifacts: initialFiles.size + revisedFiles.size, checksums: [...initialFiles.values(), ...revisedFiles.values()].map(sha), sameDisk: true, noReupload: true, priorDownloadsPreserved: true });
      completedScenarios += 1;
    }
    if (officeSelected) {
      const fixtures = JSON.parse(docker(["run", "--rm", "--network", "none", "--memory", "256m", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65534:65534", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--entrypoint", "python3", "-i", officeImage, "-I", "-c", officeOracle], JSON.stringify({ case: "office_fixtures" }))) as { files: Record<string, string> };
      const result = await runOfficeUserScenarios({ db, page, deleteChat, downloads, emit, newChat, oracle, send, waitForAttachment,
        async captureUI(name) {
          requireValue(artifactRoot && /^[a-z0-9-]+$/u.test(name), "ui_artifact_name_invalid");
          await page.screenshot({ path: join(artifactRoot, `${name}.png`) });
        },
        officeCase: officeCase as "ALL" | "STOCK" | "PRESENTATION" | "DOCX" | "MONTHLY",
        fixtures: new Map(Object.entries(fixtures.files).map(([name, value]) => [name, Buffer.from(value, "base64")])),
        setStage(value) { stage = value; },
        setStep(value) { step = value; }
      });
      completedScenarios += result.scenarios;
    }
    cleanupComplete = true;
    emit({ status: "passed", scenarios: completedScenarios, answerTurns, provider: "codex-lb", model: route.model, guestMemoryMiB: 1024,
      minimumAvailableMiB, elapsedSeconds: Math.round((Date.now() - started.getTime()) / 1000), memoryDegraded: 0, remainingGuests: guestCount() });
  } finally {
    const failureStage = stage;
    const failureStep = step;
    if (!cleanupComplete && artifactRoot) await page.screenshot({ path: join(artifactRoot, "failure.png") }).catch(() => undefined);
    if (artifactRoot) emit({ stage: "artifacts", directory: artifactRoot });
    if (!cleanupComplete) for (const chatId of ownedChats) {
      if (await db.chat.count({ where: { id: chatId } })) {
        try {
          const stop = page.getByRole("button", { name: "Stop answer" });
          if (await stop.isVisible()) await stop.click();
          await deleteChat(chatId);
        } catch { emit({ stage: "cleanup", remainingOwnedChat: true }); }
      }
    }
    await context.close(); await browser.close(); await db.$disconnect();
    if (!cleanupComplete) { stage = failureStage; step = failureStep; }
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^workspace_user_paid_[a-z0-9_]+$/u.test(error.message)
    ? error.message : "workspace_user_paid_check_failed";
  emit({ status: "failed", stage, step, code }); process.exitCode = 1;
});
