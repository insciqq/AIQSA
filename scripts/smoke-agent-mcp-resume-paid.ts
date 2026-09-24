import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { request as playwrightRequest, type APIResponse } from "@playwright/test";

// Opt-in only; run on the Docker host, never inside the persistent installation.
// Inputs: AIQSA_AGENT_MCP_PAID_E2E=DISPOSABLE, _COMPOSE_FILE (resolved JSON),
// _PROJECT, _MODEL_ID, _SYSTEM_MODEL_ID, _CODEX_LB_API_ROOT. Optional _TOKEN
// overrides the disposable Compose bootstrap token; _DOCKER can name an
// operator-provided scoped Docker wrapper. No provider secrets read.
// Optional _EVIDENCE_DIRECTORY must not exist; it retains content-free atomic
// counter snapshots. Otherwise a fresh /tmp/aiqsa-agent-mcp-paid-* is used.
// Optional _FIXTURE_PORT selects a high port on the owned bridge gateway when
// host INPUT filtering requires an operator-provisioned narrow ingress rule.
// Before execution, provision exact checked codex-lb deployments, assign the
// System Model, enable Workspace Internet, and enable bounded Agent limits
// (<=600 s, <=16 model calls, <=16 tool calls, <=4096 output tokens).
// The fixture binds only the owned Docker bridge gateway. Only app is restarted,
// after B's completed export. No paid request or ambiguous dispatch is retried.

class SmokeFailure extends Error {}
let stage = "guard";
const emit = (value: Record<string, string | number | boolean>) => process.stdout.write(`${JSON.stringify(value)}\n`);
function check(value: unknown, code: string): asserts value { if (!value) throw new SmokeFailure(code); }
function required(name: string) {
  const value = process.env[`AIQSA_AGENT_MCP_PAID_${name}`];
  check(value, `missing_${name.toLowerCase()}`); return value;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const docker = (...args: string[]) => execFileSync(process.env.AIQSA_AGENT_MCP_PAID_DOCKER ?? "docker", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, maxBuffer: 2 * 1024 * 1024
});
async function poll<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 180_000): Promise<T> {
  const deadline = Date.now() + timeout;
  do { const value = await read(); if (accept(value)) return value; await wait(1000); } while (Date.now() < deadline);
  throw new SmokeFailure("poll_timeout");
}
async function json(response: APIResponse) {
  check(response.ok(), `http_${response.status()}`);
  return response.json();
}

type Service = { environment: Record<string, string>; ports?: { target: number; published: string; host_ip: string }[] };
type Stand = { name: string; services: Record<string, Service>; volumes?: Record<string, { external?: boolean }> };

async function main() {
  check(required("E2E") === "DISPOSABLE", "disposable_opt_in_required");
  const composeFile = required("COMPOSE_FILE"), project = required("PROJECT");
  check(/^aiqsa-(?:ws-paid|agent-mcp-paid|queue-stage1|stage1|test)-[a-z0-9-]{8,48}$/u.test(project), "disposable_project_required");
  const stand = JSON.parse(readFileSync(composeFile, "utf8")) as Stand;
  check(stand.name === project && stand.services.app && stand.services.postgres && stand.services["workspace-runner"], "compose_identity_mismatch");
  check(!Object.values(stand.volumes ?? {}).some(volume => volume.external), "external_volume_forbidden");
  const compose = (...args: string[]) => docker("compose", "--env-file", "/dev/null", "-p", project, "-f", composeFile, ...args);
  const infos = new Map<string, { State: { Running: boolean; OOMKilled: boolean; StartedAt: string };
    Config: { Env: string[]; Labels: Record<string, string> }; NetworkSettings: { Networks: Record<string, { Gateway: string }> } }>();
  for (const role of ["app", "postgres", "workspace-runner", "workspace-maintenance"]) {
    const id = compose("ps", "-q", role).trim(); check(id, "stand_role_missing");
    const info = JSON.parse(docker("inspect", id))[0];
    check(info.Config.Labels["com.docker.compose.project"] === project && info.State.Running && !info.State.OOMKilled, "stand_role_invalid");
    if (role === "postgres") {
      check(info.Config.Env.includes("PGDATA=/var/lib/postgresql/18/docker") &&
        info.Mounts.some((mount: { Type: string; Destination: string }) =>
          mount.Destination === "/var/lib/postgresql" && mount.Type === "volume"), "database_volume_required");
    }
    for (const mount of info.Mounts as { Type: string; Name?: string; Destination: string }[]) {
      if (mount.Type === "volume") {
        const volume = JSON.parse(docker("volume", "inspect", mount.Name!))[0];
        check(volume.Labels?.["com.docker.compose.project"] === project, "foreign_volume_forbidden");
      }
    }
    infos.set(role, info);
    if (role !== "postgres") {
      const env = Object.fromEntries((info.Config.Env as string[]).map(entry => {
        const split = entry.indexOf("="); return [entry.slice(0, split), entry.slice(split + 1)];
      }));
      check(env.AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME === "0", "real_workspace_required");
      for (const key of ["AIQSA_WORKSPACE_RUNNER_URL", "AIQSA_WORKSPACE_RUNNER_TOKEN", "AIQSA_WORKSPACE_IMAGE"]) {
        if (stand.services[role]!.environment[key]) check(env[key] === stand.services[role]!.environment[key], "running_configuration_mismatch");
      }
    }
  }
  compose("exec", "-T", "workspace-runner", "test", "-r", "/dev/kvm");
  const port = (role: string, target: number) => {
    const mapping = stand.services[role]?.ports?.find(item => item.target === target);
    check(mapping?.host_ip === "127.0.0.1" && /^\d+$/u.test(mapping.published), "loopback_port_required");
    check(Number(mapping.published) >= 1024 && Number(mapping.published) <= 65535, "port_invalid");
    return mapping.published;
  };
  const tls = Boolean(stand.services["browser-tls"]);
  const baseURL = tls ? `https://127.0.0.1:${port("browser-tls", 8443)}` : `http://127.0.0.1:${port("app", 3000)}`;
  const appEnv = stand.services.app!.environment;
  const databaseUrl = new URL(appEnv.DATABASE_URL!);
  check(databaseUrl.protocol === "postgresql:" && databaseUrl.hostname === "postgres" && databaseUrl.pathname === "/aiqsa" &&
    databaseUrl.username === "aiqsa" && databaseUrl.password, "database_target_invalid");
  databaseUrl.hostname = "127.0.0.1"; databaseUrl.port = port("postgres", 5432); databaseUrl.search = "";
  const networkEntry = Object.entries(infos.get("app")!.NetworkSettings.Networks).find(([name]) => name === `${project}_default`);
  check(networkEntry, "owned_bridge_required");
  const network = JSON.parse(docker("network", "inspect", networkEntry[0]))[0];
  const bridge = networkEntry[1].Gateway;
  check(network.Driver === "bridge" && network.Labels["com.docker.compose.project"] === project &&
    /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/u.test(bridge), "owned_bridge_invalid");
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });
  const api = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: tls, timeout: 30_000,
    extraHTTPHeaders: { origin: baseURL } });
  const ownedServers: string[] = [];
  let chatId: string | undefined;
  let userId: string | undefined;
  let fixture: ReturnType<typeof createServer> | undefined;
  let passed = false;
  let cleanupComplete = true;
  const prefix = `agent-resume-${randomBytes(6).toString("hex")}`;
  const requestedEvidenceDirectory = process.env.AIQSA_AGENT_MCP_PAID_EVIDENCE_DIRECTORY;
  const evidenceDirectory = requestedEvidenceDirectory ?? mkdtempSync(join(tmpdir(), "aiqsa-agent-mcp-paid-"));
  if (requestedEvidenceDirectory) mkdirSync(evidenceDirectory, { mode: 0o700 });
  const names = ["quartz_delta", "violet_sigma"];
  const calls: { tool: number; marker: string }[] = [];
  let invalidCalls = 0;
  let initializeRequests = 0;
  let listRequests = 0;
  const checkpointCounters = () => {
    const pending = join(evidenceDirectory, `counters-${randomUUID()}.tmp`);
    writeFileSync(pending, JSON.stringify({ version: 1, total: calls.length, invalid: invalidCalls, initializeRequests, listRequests,
      calls: calls.map(call => ({ tool: call.tool, markerHash: createHash("sha256").update(call.marker).digest("hex") })) }),
    { flag: "wx", mode: 0o600, flush: true });
    renameSync(pending, join(evidenceDirectory, "counters.json"));
  };
  checkpointCounters();
  try {
    stage = "preflight";
    check(await db.modelRun.count({ where: { status: { in: ["queued", "preparing", "in_progress", "streaming"] } } }) === 0, "idle_stand_required");
    const modelId = required("MODEL_ID"), systemModelId = required("SYSTEM_MODEL_ID");
    const root = new URL(required("CODEX_LB_API_ROOT")).toString().replace(/\/$/u, "");
    for (const id of new Set([modelId, systemModelId])) {
      const model = await db.providerModel.findUniqueOrThrow({ where: { id }, include: { connection: { include: { credentials: true } } } });
      const config = record(model.activeConfig), connection = model.connection;
      check(model.enabled && connection.enabled && connection.family === "openai_compatible" &&
        record(connection.activeConfig).apiRoot === root && config.adapterKind === "openai_responses_compatible", "codex_lb_route_mismatch");
      const credential = connection.credentials.find(item => item.id === connection.defaultCredentialId && item.enabled);
      check(credential?.activeVersionId, "default_credential_missing");
      check(await db.providerModelCredentialCheck.count({ where: { providerModelId: id, connectionId: connection.id,
        connectionVersion: connection.activeVersion, modelVersion: model.activeVersion, credentialVersionId: credential.activeVersionId,
        status: "available" } }) === 1, "exact_compatibility_evidence_missing");
    }
    const token = process.env.AIQSA_AGENT_MCP_PAID_TOKEN ?? appEnv.AIQSA_BOOTSTRAP_AUTH_TOKEN;
    check(token, "bootstrap_token_required");
    const login = await json(await api.post("/api/auth/token", { data: { token } }));
    userId = login.user.id;
    check(userId && login.user.role === "admin", "synthetic_admin_required");
    const system = (await json(await api.get("/api/admin/providers/system-model-policy"))).systemModelPolicy;
    check(system.policy.systemModel?.id === systemModelId && system.policy.systemModel.available &&
      system.candidates.some((candidate: { id: string }) => candidate.id === systemModelId), "system_model_not_ready");
    check(!system.policy.chatTitleModel && !system.policy.decisionModel, "optional_paid_roles_must_be_off");
    const workspace = (await json(await api.get("/api/admin/workspace"))).workspace;
    const workspacePolicy = workspace.policy ?? workspace;
    check(workspacePolicy.enabled && workspacePolicy.internetEnabled, "workspace_internet_required");
    const agent = (await json(await api.get("/api/admin/workspace/agent"))).agent;
    check(agent.limitsEnabled && agent.timeoutSeconds <= 600 && agent.maxModelCalls <= 16 && agent.maxToolCalls <= 16 &&
      agent.maxOutputTokens <= 4096, "bounded_agent_policy_required");
    const catalog = (await json(await api.get("/api/me/catalog"))).catalog;
    const model = catalog.models.find((candidate: { modelId: string }) => candidate.modelId === modelId);
    check(model?.agentAvailable, "agent_model_not_available");
    const connectionId = (await db.providerModel.findUniqueOrThrow({ where: { id: modelId }, select: { connectionId: true } })).connectionId;
    const existingMcp = (await json(await api.get("/api/me/mcp"))).servers;
    check(existingMcp.every((server: { enabled: boolean }) => !server.enabled), "foreign_mcp_enabled");

    stage = "fixture";
    fixture = createServer(async (request, response) => {
      try {
        const index = request.url === "/quartz" ? 0 : request.url === "/violet" ? 1 : -1;
        if (index < 0) { response.writeHead(404).end(); return; }
        if (request.method !== "POST") { response.writeHead(405).end(); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk); bytes += buffer.length;
          if (bytes > 65_536) { response.writeHead(413).end(); return; }
          chunks.push(buffer);
        }
        const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (rpc.id === undefined) { response.writeHead(202).end(); return; }
        let result: unknown;
        if (rpc.method === "initialize") {
          initializeRequests++; checkpointCounters();
          result = { protocolVersion: rpc.params.protocolVersion,
            capabilities: { tools: {} }, serverInfo: { name: `synthetic-${index}`, version: "1.0.0" } };
        }
        else if (rpc.method === "ping") result = {};
        else if (rpc.method === "tools/list") {
          listRequests++; checkpointCounters();
          result = { tools: [{ name: names[index],
            description: `Record the synthetic qualification marker with ${index === 0 ? "quartz" : "violet"}. This is a disposable counter.`,
            inputSchema: { type: "object", additionalProperties: false, properties: { marker: { type: "string", minLength: 1, maxLength: 80 } }, required: ["marker"] } }] };
        }
        else if (rpc.method === "tools/call") {
          const marker = rpc.params?.arguments?.marker;
          if (rpc.params?.name !== names[index] || typeof marker !== "string" || marker.length > 80) {
            invalidCalls++; checkpointCounters(); result = { isError: true, content: [{ type: "text", text: "invalid_arguments" }] };
          } else {
            calls.push({ tool: index, marker });
            checkpointCounters();
            result = { content: [{ type: "text", text: JSON.stringify({ recorded: true, marker, receipt: calls.length }) }] };
          }
        } else {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id,
            error: { code: -32601, message: "Method not found" } })); return;
        }
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      } catch { if (!response.headersSent) response.writeHead(400); response.end(); }
    });
    const configuredFixturePort = process.env.AIQSA_AGENT_MCP_PAID_FIXTURE_PORT;
    const fixturePort = configuredFixturePort === undefined ? 0 : Number(configuredFixturePort);
    check(configuredFixturePort === undefined || /^\d+$/u.test(configuredFixturePort) &&
      Number.isInteger(fixturePort) && fixturePort >= 1024 && fixturePort <= 65535, "fixture_port_invalid");
    await new Promise<void>((resolve, reject) => { fixture!.once("error", reject); fixture!.listen(fixturePort, bridge, resolve); });
    const address = fixture.address(); check(address && typeof address !== "string", "fixture_port_missing");
    for (const path of ["quartz", "violet"]) {
      stage = `fixture_activate_${path}`;
      const created = await json(await api.post("/api/admin/mcp", { data: { name: `${prefix}-${path}`, activate: true,
        description: "Disposable native Agent continuation qualification", draft: {
          auth: { mode: "none" }, slots: [], transport: "streamable_http", runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 30_000 },
          source: { kind: "remote", allowPrivateNetwork: true, url: `http://${bridge}:${address.port}/${path}` }
        } } }));
      const id = created.server.id as string; ownedServers.push(id);
      const activated = await poll(() => db.mcpServer.findUnique({ where: { id }, include: {
        activationJob: { select: { stage: true, errorCode: true } }
      } }), value => Boolean(value?.enabled && value.activeRevisionId || value?.activationJob?.stage === "failed"));
      if (activated?.activationJob?.stage === "failed") {
        const code = activated.activationJob.errorCode;
        emit({ stage, success: false, code: code && /^[a-z0-9_]{1,96}$/u.test(code) ? code : "mcp_activation_failed",
          initialize_requests: initializeRequests, list_requests: listRequests, business_calls: calls.length });
        throw new SmokeFailure("fixture_activation_failed");
      }
      await json(await api.put(`/api/admin/mcp/${id}/grants`, { data: { canUse: true, userId, personalSlotKeys: [] } }));
      await json(await api.patch(`/api/me/mcp/${id}`, { data: { enabled: true } }));
    }
    stage = "fixture_readiness";
    // Enabling a connection admits it without starting a runtime. Discovery or
    // execution materializes that runtime on demand; a catalog read must not.
    await poll(async () => (await json(await api.get("/api/me/mcp"))).servers as {
      enabled: boolean; id: string; knownToolCount: number; readiness: string;
    }[], servers => ownedServers.every(id => servers.some(server => server.id === id && server.enabled &&
      server.knownToolCount === 1 && ["idle", "ready"].includes(server.readiness))));
    check(Number(calls.length) === 0, "activation_called_business_tool");
    const createdChat = await json(await api.post("/api/chats", { data: { title: prefix, memoryMode: "EXCLUDED", workspaceEnabled: true } }));
    chatId = createdChat.chat.id;
    check(chatId, "chat_missing");
    const owner = await db.chat.findUniqueOrThrow({ where: { id: chatId }, select: { userId: true } });
    const runIds: string[] = [];
    async function turn(label: string, text: string) {
      stage = `turn_${label}`;
      const before = await db.modelRun.findMany({ where: { chatId }, select: { id: true } });
      const chat = await db.chat.findUniqueOrThrow({ where: { id: chatId! }, select: { activeLeafMessageId: true } });
      // Exactly one HTTP submission. A transport timeout is ambiguous, never a retry.
      const response = await api.post(`/api/chats/${chatId}/messages`, { timeout: 650_000, data: {
        admissionId: randomUUID(), expectedActiveLeafId: chat.activeLeafMessageId,
        provider: connectionId, modelId, text, agentEnabled: true, workspaceEnabled: true,
        mcp: { mode: "auto" }, searchPlan: { mode: "all_selected", optionIds: [] }, reasoningEffort: "low"
      } });
      check(response.ok(), `turn_http_${response.status()}`);
      check((await response.body()).length <= 2 * 1024 * 1024, "response_envelope_too_large");
      const run = await poll(() => db.modelRun.findFirst({ where: { chatId, id: { notIn: before.map(value => value.id) } },
        select: { id: true, status: true, userId: true, workspaceRunBinding: { select: { exportState: true, workspaceSessionId: true } } } }),
        value => Boolean(value && ["complete", "error", "cancelled"].includes(value.status)), 650_000);
      check(run?.status === "complete" && run.userId === owner.userId, "native_turn_not_complete");
      await poll(() => db.workspaceRunBinding.findUnique({ where: { modelRunId: run.id }, select: { exportState: true } }), value => value?.exportState === "COMPLETE");
      runIds.push(run.id);
      const binding = await db.agentRunBinding.findUniqueOrThrow({ where: { modelRunId: run.id } });
      check(binding.completedAt && binding.threadId && !binding.failureCode && binding.revokedAt, "native_binding_not_settled");
      const tools = await db.agentMcpTool.findMany({ where: { modelRunId: run.id }, orderBy: { toolId: "asc" } });
      const discovery = await db.modelRunToolCall.count({ where: { modelRunId: run.id, toolName: "find_tools" } });
      check(tools.length === 2 && await db.mcpRunBinding.count({ where: { modelRunId: run.id } }) === 2, "fresh_admissions_missing");
      check(await db.agentProviderAttempt.count({ where: { modelRunId: run.id, state: "UNKNOWN" } }) === 0, "provider_outcome_unknown");
      return { run, binding, tools, discovery };
    }
    const markerA = `${prefix}-A`, markerC = `${prefix}-C`;
    const a = await turn("a", `This is a synthetic integration check. Use find_tools to discover quartz_delta and violet_sigma. Call each exactly once with marker ${JSON.stringify(markerA)}. Do not call any other tools, browse, use shell commands, or create files. Report completion only after both actual results. Do not repeat an uncertain operation.`);
    check(a.binding.resumedFromRunId === null && a.discovery >= 1 && a.discovery <= 2, "initial_discovery_missing");
    check(Number(calls.length) === 2 && names.every((_name, tool) => calls.filter(call => call.tool === tool && call.marker === markerA).length === 1), "initial_business_calls_invalid");
    const aSnapshot = JSON.stringify(a.tools);
    const b = await turn("b", "Keep the established MCP definitions for a later turn. For this turn only answer 'Ready'. Do not call any tools, including find_tools, and do not access files or the network.");
    check(b.binding.resumedFromRunId === a.run.id && b.binding.threadId === a.binding.threadId && b.discovery === 0 && Number(calls.length) === 2, "idle_continuation_invalid");
    stage = "worker_restart";
    check(await db.modelRun.count({ where: { status: { in: ["queued", "preparing", "in_progress", "streaming"] } } }) === 0, "restart_requires_idle_stand");
    const startedAt = infos.get("app")!.State.StartedAt;
    compose("restart", "app");
    const restarted = JSON.parse(docker("inspect", compose("ps", "-q", "app").trim()))[0];
    check(restarted.State.StartedAt !== startedAt && restarted.Config.Labels["com.docker.compose.project"] === project, "worker_restart_unproven");
    await poll(async () => { try { return (await api.get("/api/health/live")).ok(); } catch { return false; } }, value => value);
    const c = await turn("c", `Using the exact tool IDs, versions and schemas already discovered in this native conversation, call quartz_delta and violet_sigma once each with marker ${JSON.stringify(markerC)}. Do not call find_tools again unless the gateway explicitly requires discovery. Do not browse, use shell commands, or create files. Never repeat an uncertain operation.`);
    check(c.binding.resumedFromRunId === b.run.id && c.binding.threadId === a.binding.threadId && c.discovery === 0, "resumed_discovery_not_reused");
    check(c.run.workspaceRunBinding?.workspaceSessionId === a.run.workspaceRunBinding?.workspaceSessionId, "workspace_continuity_lost");
    check(Number(calls.length) === 4 && invalidCalls === 0 && names.every((_name, tool) => calls.filter(call => call.tool === tool && call.marker === markerC).length === 1), "unexpected_business_replay");
    for (const next of [b, c]) check(next.tools.every(tool => a.tools.some(original => original.toolId === tool.toolId && original.version === tool.version)), "tool_version_drift");
    check(JSON.stringify(await db.agentMcpTool.findMany({ where: { modelRunId: a.run.id }, orderBy: { toolId: "asc" } })) === aSnapshot, "historical_admission_changed");
    check(new Set([a.binding.tokenHash, b.binding.tokenHash, c.binding.tokenHash]).size === 3, "authority_copied");
    check(await db.modelRunToolCall.count({ where: { modelRunId: { in: runIds }, state: "error" } }) === 0, "unexpected_tool_failure");
    passed = true;
    emit({ stage: "verified", native_turns: 3, synthetic_servers: 2, business_calls: calls.length,
      initial_discovery_calls: a.discovery, continued_discovery_calls: b.discovery + c.discovery, app_restart: true, replay: false });
  } catch (error) {
    emit({ stage, success: false, code: error instanceof SmokeFailure ? error.message : "unexpected_failure" });
    throw error;
  } finally {
    const operationStage = stage;
    stage = "cleanup";
    // Recover identities of our unique synthetic creations after ambiguous HTTP
    // responses. Never resend their creation or an Agent turn.
    try {
      for (const server of await db.mcpServer.findMany({ where: { displayName: { in: [`${prefix}-quartz`, `${prefix}-violet`] },
        archivedAt: null }, select: { id: true } })) if (!ownedServers.includes(server.id)) ownedServers.push(server.id);
      if (!chatId && userId) chatId = (await db.chat.findFirst({ where: { title: prefix, userId }, select: { id: true } }))?.id;
    } catch { cleanupComplete = false; }
    if (chatId) {
      try {
        await json(await api.post(`/api/chats/${chatId}/delete-permanently`, { data: {
          alsoForgetOriginMemories: true, confirmationCopyVersion: "memory-confirmation-v1", requestId: randomUUID()
        } }));
        await poll(() => db.chat.count({ where: { id: chatId } }), count => count === 0);
      } catch { cleanupComplete = false; }
    }
    for (const id of ownedServers) {
      try {
        await json(await api.delete(`/api/admin/mcp/${id}`));
        check(await db.mcpServer.count({ where: { id, archivedAt: { not: null }, enabled: false } }) === 1, "server_cleanup_failed");
      } catch { cleanupComplete = false; }
    }
    if (fixture) { fixture.closeAllConnections(); await new Promise<void>(resolve => fixture!.close(() => resolve())); }
    await api.dispose(); await db.$disconnect();
    emit({ stage: "cleanup", cleanup_complete: cleanupComplete, success: passed && cleanupComplete });
    check(cleanupComplete, "cleanup_incomplete");
    stage = operationStage;
  }
}

main().catch(error => {
  emit({ stage, success: false, code: error instanceof SmokeFailure ? error.message : "unexpected_failure" });
  process.exitCode = 1;
});
