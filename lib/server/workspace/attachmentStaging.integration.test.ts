// @vitest-environment node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WORKSPACE_MCP_TOOL_ALLOWLIST, workspaceRunOutputDirectory } from "@/lib/domain/workspace";
import type { NormalizedRunWorkspace } from "@/lib/server/providers/types";
import { createS3StorageAdapter, getStoredObjectStream, type StorageAdapter, type StoredObjectReadStream } from "../uploads/storage";
import { getWorkspaceConfig } from "./config";
import { createWorkspaceCoordinator, type WorkspaceCoordinatorRepository, type WorkspaceExecutionBinding } from "./coordinator";
import type { WorkspaceExecutionRegistry } from "./executionRegistry";
import type { WorkspaceBoundTool, WorkspaceRuntime } from "./runtime";
import { namespacedWorkspaceToolName } from "./toolCatalog";

/**
 * Real private object storage with the production S3 client (its default
 * NodeHttpHandler pool of 50 sockets): staging more originals than the pool
 * holds must finish, and a concurrent run on the same client must progress.
 */
const s3Configured = Boolean(process.env.S3_ENDPOINT && process.env.S3_BUCKET &&
  process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
if (!s3Configured) console.warn("attachment staging integration skipped: S3_ENDPOINT, S3_BUCKET and S3 credentials are not configured");

const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });
const prefix = `workspace-staging-integration/${randomUUID()}`;
const created: string[] = [];
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
let storage: StorageAdapter | undefined;

function adapter(): StorageAdapter {
  storage ??= createS3StorageAdapter();
  return storage;
}

afterAll(async () => {
  if (!storage) return;
  const failures = (await Promise.allSettled(created.map((key) => storage!.deleteObject(key)))).filter((result) => result.status === "rejected");
  expect(failures).toHaveLength(0);
});

type StoredOriginal = Readonly<{ attachmentId: string; bytes: Buffer; messageId: string; fileName: string; storageKey: string }>;

async function upload(run: string, count: number): Promise<StoredOriginal[]> {
  const files: StoredOriginal[] = [];
  for (let index = 0; index < count; index += 1) {
    // 192–256 KiB keeps each response larger than socket buffering, so an
    // unread body really holds its pooled connection.
    const bytes = randomBytes(192 * 1024 + (index % 5) * 16 * 1024);
    const storageKey = `${prefix}/${run}/${index}`;
    created.push(storageKey);
    await adapter().putObject({ body: bytes, contentType: "application/octet-stream", storageKey });
    files.push({ attachmentId: `${run}_attachment_${index}`, bytes, fileName: `${run}-${index}.bin`, messageId: `${run}_message_${index % 3}`, storageKey });
  }
  return files;
}

function within<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), ms);
  })]).finally(() => clearTimeout(timer));
}

const unused = async (): Promise<never> => { throw new Error("unused_in_staging_integration"); };

/** One accepted run with in-memory authority and a guest stand-in that consumes and verifies each original. */
function run(name: string, files: readonly StoredOriginal[], hooks: Readonly<{ afterFirstChunk?: (attachmentId: string) => Promise<void> }> = {}) {
  const runId = `run_${name}`;
  const tools: WorkspaceBoundTool[] = WORKSPACE_MCP_TOOL_ALLOWLIST.map((tool) => ({
    description: tool, inputSchema: { properties: {}, type: "object" },
    namespacedName: namespacedWorkspaceToolName(tool), originalName: tool
  }));
  const workspace: NormalizedRunWorkspace = {
    enabled: true, imageRef: config.imageRef, inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: false,
    maxToolCalls: config.maxToolCalls, maxToolRounds: config.maxToolRounds, mcpVersion: "0.6.16",
    messageManifestPath: "/workspace/inbox/messages/message_1/manifest.json", outputDirectory: workspaceRunOutputDirectory(runId),
    projectDirectory: "/workspace/project", runtimeVersion: "0.6.16", sessionId: `session_${name}`,
    syncToolTimeoutSeconds: 30, toolCatalogHash: "a".repeat(64), turnTimeoutSeconds: config.turnTimeoutSeconds
  };
  let runtimeSandboxId: string | null = null;
  let sessionState = "PENDING";
  const operation = { generation: 1, owner: `run:${runId}` };
  const binding = (): WorkspaceExecutionBinding => ({
    assistantMessageId: `assistant_${name}`, chatId: `chat_${name}`, guestUsed: true, imageRef: workspace.imageRef,
    internetEnabled: workspace.internetEnabled, mcpVersion: workspace.mcpVersion, outputDirectory: workspace.outputDirectory,
    operationOwner: operation.owner, operationGeneration: operation.generation, policyRevision: 1, projectId: null, runId,
    runtimeSandboxId, runtimeVersion: workspace.runtimeVersion, sandboxName: `aiqsa-ws-${name}`, sessionId: workspace.sessionId,
    sessionErrorCode: null, sessionState, toolCatalogHash: workspace.toolCatalogHash, toolDefinitions: tools, userId: "user_staging"
  });
  const failures: string[] = [];
  const repository: WorkspaceCoordinatorRepository = {
    async attachments() {
      return files.map((file) => ({ attachmentId: file.attachmentId, byteSize: file.bytes.byteLength, checksum: sha256(file.bytes),
        fileName: file.fileName, kind: "file" as const, messageId: file.messageId, mimeType: "application/octet-stream", storageKey: file.storageKey }));
    },
    async binding() { return binding(); },
    claimExport: unused, claimExportForRecovery: unused, exportRecoveryCandidates: unused, generatedFiles: unused,
    async markGuestUsed() { return true; },
    async markSessionFailed(input) { sessionState = "FAILED"; failures.push(input.code); },
    async markSessionLost() { return null; },
    async markSessionReady() {},
    async markSessionRunning(input) { runtimeSandboxId = input.runtimeSandboxId; sessionState = "RUNNING"; return true; },
    async markSessionStarting() { sessionState = "CREATING"; return true; },
    markExportComplete: unused, markExportFailed: unused, markExportPending: unused, outputHandoffReady: unused,
    async personalSecrets() { return []; },
    prepareOutput: unused, renewExportLease: unused, reserveOutputCapture: unused, retireUnusedRun: unused,
    saveBrowserSessions: unused, sealOutputCapture: unused, settleOutput: unused, settleSession: unused,
    async unregisteredCommands() { return 0; }
  };
  const written = new Map<string, Buffer>();
  const runtime: WorkspaceRuntime = {
    callBoundTool: vi.fn(async () => ({ content: [{ text: "ok", type: "text" as const }], status: "complete" as const })),
    cancelToolCall: unused, collectBrowserSessions: unused, collectOutputs: unused, completeSkillRunPreparation: vi.fn(async () => undefined),
    createProjectArchive: unused,
    ensureSession: vi.fn(async () => ({ runtimeSandboxId: `runtime_${name}`, sandboxName: binding().sandboxName, state: "ready" as const })),
    health: unused, installSkillBundle: unused, listStagedAttachments: vi.fn(async () => []),
    loadBoundTools: vi.fn(async () => ({ hash: workspace.toolCatalogHash, mcpVersion: workspace.mcpVersion, runtimeVersion: workspace.runtimeVersion, tools })),
    prepareSkillRun: vi.fn(async () => ({ state: "ready" as const })), removeSession: unused,
    stageAttachments: vi.fn(async (input: Parameters<WorkspaceRuntime["stageAttachments"]>[0]) => {
      for (const attachment of input.attachments) {
        const reader = attachment.body.getReader();
        const chunks: Buffer[] = [];
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(Buffer.from(next.value));
          if (chunks.length === 1) await hooks.afterFirstChunk?.(attachment.attachmentId);
        }
        const bytes = Buffer.concat(chunks);
        if (bytes.byteLength !== attachment.byteSize || sha256(bytes) !== attachment.checksum) throw new Error("staged_bytes_mismatch");
        written.set(attachment.attachmentId, bytes);
      }
    }),
    stopSession: unused, syncPersonalSecrets: vi.fn(async () => undefined), terminateExecutions: unused
  };
  const registry: WorkspaceExecutionRegistry = { closeAll: unused, find: unused, listOpen: async () => [], register: unused, transition: unused };
  const coordinator = createWorkspaceCoordinator({ config, registry, repository, runtime, storage: adapter() });
  return {
    failures,
    written,
    execute: () => coordinator.execute({
      call: { arguments: { path: "/workspace/inbox/index.json" }, id: `call_${name}`, name: namespacedWorkspaceToolName("sandbox_fs_read") },
      modelRunToolCallId: `stored_${name}`, runId, userId: "user_staging", workspace
    })
  };
}

function expectExact(written: Map<string, Buffer>, files: readonly StoredOriginal[]) {
  expect(written.size).toBe(files.length);
  for (const file of files) expect(sha256(written.get(file.attachmentId) ?? Buffer.alloc(0))).toBe(sha256(file.bytes));
}

describe.skipIf(!s3Configured)("Workspace attachment staging against the private object store", () => {
  let large: StoredOriginal[] = [];
  let small: StoredOriginal[] = [];

  beforeAll(async () => {
    large = await upload("large", 60);
    small = await upload("small", 2);
  }, 120_000);

  it("proves the client pool is bounded: unread bodies block the next open until they are released", async () => {
    const opened: StoredObjectReadStream[] = [];
    const blocked = new AbortController();
    try {
      let stalled: Promise<StoredObjectReadStream> | null = null;
      for (const file of large) {
        const next = getStoredObjectStream(adapter(), file.storageKey, { maxBytes: file.bytes.byteLength, requireStreaming: true, signal: blocked.signal });
        next.catch(() => undefined);
        const settled = await within(next, 3_000, "open_pending").catch((error: unknown) => {
          if (error instanceof Error && error.message === "open_pending") return null;
          throw error;
        });
        if (!settled) { stalled = next; break; }
        opened.push(settled);
      }
      // Opening every original before consuming any is the former deadlock.
      expect(stalled).not.toBeNull();
      expect(opened.length).toBeGreaterThanOrEqual(50);
      blocked.abort(new Error("synthetic_pool_probe_released"));
      await expect(stalled).rejects.toBeDefined();
    } finally {
      blocked.abort(new Error("synthetic_pool_probe_released"));
      await Promise.allSettled(opened.map((object) => object.body.cancel()));
    }
    const fresh = await within(getStoredObjectStream(adapter(), large[0]!.storageKey, { maxBytes: large[0]!.bytes.byteLength, requireStreaming: true }),
      10_000, "pool_not_released");
    expect(sha256(Buffer.from(await new Response(fresh.body).arrayBuffer()))).toBe(sha256(large[0]!.bytes));
  }, 300_000);

  it("stages more originals than the pool holds while a concurrent small run on the same client completes", async () => {
    let paused!: () => void;
    const reached = new Promise<void>((resolve) => { paused = resolve; });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const largeRun = run("large", large, {
      async afterFirstChunk(attachmentId) {
        if (attachmentId !== large[30]!.attachmentId) return;
        paused();
        await gate;
      }
    });
    const smallRun = run("small", small);
    const largeResult = largeRun.execute();
    largeResult.catch(() => undefined);
    try {
      await within(reached, 60_000, "large_run_did_not_reach_mid_transfer");
      expect(largeRun.written.size).toBe(30);
      await expect(within(smallRun.execute(), 60_000, "small_run_stalled")).resolves.toMatchObject({ status: "complete" });
      expectExact(smallRun.written, small);
    } finally {
      resume();
    }
    await expect(within(largeResult, 60_000, "large_run_stalled")).resolves.toMatchObject({ status: "complete" });
    expectExact(largeRun.written, large);
    expect([...largeRun.failures, ...smallRun.failures]).toEqual([]);
  }, 180_000);
});
