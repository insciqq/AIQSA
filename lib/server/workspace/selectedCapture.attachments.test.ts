import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prisma, PrismaClient, WorkspaceSelectedCapture } from "@prisma/client";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import type { AvailableVisionAnalysisPlan } from "../providerRuntime/visionAnalysis";
import type { ProviderRunRequest } from "../providers/types";
import { createVisionAnalysisService } from "../vision/service";
import { getWorkspaceConfig } from "./config";
import { parseWorkspaceImageEvidence } from "./directImageEvidence";
import { createDirectImageBudget, createWorkspaceImageViewer } from "./directImageView";
import { WorkspaceOutputCaptureStore } from "./outputCapture";
import { workspaceOutputCollection, type WorkspaceRuntime } from "./runtime";
import { createWorkspaceSelectedCaptures } from "./selectedCapture";

const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(ownerRunId = "main") {
  const directory = await mkdtemp(join(tmpdir(), "selected-capture-attachments-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const spool = new WorkspaceOutputCaptureStore(directory, config);
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: "#ff0000" } }).png().toBuffer();
  const operation = { generation: 7, owner: `run:${ownerRunId}` };
  const session = { id: "session", chatId: "chat", state: "RUNNING", runtimeSandboxId: "sandbox",
    version: operation.generation, operationOwner: operation.owner };
  const chat = { id: "chat", userId: "user", archived: false, permanentDeletionAt: null };
  const runs = ["main", "subagent"].map(id => ({ id, userId: "user", chatId: "chat", status: "in_progress", chat,
    subagentThreadId: id === "main" ? null : "thread", workspaceRunBinding: { modelRunId: id, workspaceSessionId: session.id } }));
  const attached = new Set(runs.map(run => run.id));
  const captures = new Map<string, WorkspaceSelectedCapture>();
  type Reference = { captureId: string; consumerRunId: string; consumerKey: string; releasedAt: Date | null };
  const references: Reference[] = [];
  type File = { captureId: string; relativePath: string; byteSize: number; checksum: string; mimeType: string };
  const files: File[] = [];
  const leases = new Map<string, { token: string; captureId: string }>();
  const db = {
    $queryRaw: vi.fn(async () => []),
    modelRun: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => runs.find(run => run.id === where.id)),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => runs.find(run => run.id === where.id))
    },
    user: { findFirst: vi.fn(async () => ({ id: "user" })) },
    chat: { findUnique: vi.fn(async () => chat) },
    workspaceSession: { findUnique: vi.fn(async () => session) },
    workspaceRunAttachment: { findMany: vi.fn(async ({ where }: { where: { operationGeneration: number } }) =>
      where.operationGeneration === operation.generation
        ? runs.filter(run => attached.has(run.id)).map(run => ({ modelRunId: run.id, modelRun: run })) : []) },
    workspaceRunBinding: { updateMany: vi.fn(async () => ({ count: 1 })) },
    workspaceSelectedCapture: {
      count: vi.fn(async () => captures.size),
      findUnique: vi.fn(async ({ where }: { where: { id?: string; modelRunId_requestKey?: { modelRunId: string; requestKey: string } } }) => {
        const row = where.id ? captures.get(where.id) : [...captures.values()].find(capture =>
          capture.modelRunId === where.modelRunId_requestKey?.modelRunId && capture.requestKey === where.modelRunId_requestKey?.requestKey);
        return row ? { ...row, binding: { modelRun: { chatId: "chat" } } } : null;
      }),
      create: vi.fn(async ({ data }: { data: WorkspaceSelectedCapture & { references: { create: Omit<Reference, "captureId" | "releasedAt"> } } }) => {
        // Exercise the production constraint without connecting to PostgreSQL.
        if (!data.producerOwner.startsWith("run:") || JSON.stringify((data.selection as Prisma.JsonObject).producerOperation) !==
          JSON.stringify({ generation: data.producerGeneration, owner: data.producerOwner })) {
          throw new Error("WorkspaceSelectedCapture_identity_check: 23514");
        }
        const row = { ...data, state: "CAPTURING", sealedAt: null, releasedAt: null };
        captures.set(row.id, row);
        references.push({ ...data.references.create, captureId: row.id, releasedAt: null });
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<WorkspaceSelectedCapture> }) =>
        Object.assign(captures.get(where.id)!, data))
    },
    workspaceCaptureReference: {
      findUnique: vi.fn(async ({ where }: { where: { captureId_consumerRunId_consumerKey: Omit<Reference, "releasedAt"> } }) => {
        const key = where.captureId_consumerRunId_consumerKey;
        return references.find(ref => ref.captureId === key.captureId && ref.consumerRunId === key.consumerRunId && ref.consumerKey === key.consumerKey);
      }),
      create: vi.fn(async ({ data }: { data: Omit<Reference, "releasedAt"> }) => { references.push({ ...data, releasedAt: null }); }),
      count: vi.fn(async ({ where }: { where: { captureId: string; releasedAt?: null } }) => references.filter(ref =>
        ref.captureId === where.captureId && (where.releasedAt === undefined || ref.releasedAt === null)).length),
      updateMany: vi.fn(async ({ where, data }: { where: Omit<Reference, "releasedAt">; data: { releasedAt: Date } }) => {
        for (const ref of references) if (ref.captureId === where.captureId && ref.consumerRunId === where.consumerRunId && ref.consumerKey === where.consumerKey)
          ref.releasedAt = data.releasedAt;
        return { count: 1 };
      })
    },
    workspaceCapturedFile: {
      createMany: vi.fn(async ({ data }: { data: File[] }) => { files.push(...data); return { count: data.length }; }),
      findMany: vi.fn(async ({ where }: { where: { captureId: string } }) => files.filter(file => file.captureId === where.captureId)),
      findUnique: vi.fn(async ({ where }: { where: { captureId_relativePath: { captureId: string; relativePath: string } } }) =>
        files.find(file => file.captureId === where.captureId_relativePath.captureId && file.relativePath === where.captureId_relativePath.relativePath))
    },
    workspaceCaptureReadLease: {
      count: vi.fn(async () => leases.size),
      create: vi.fn(async ({ data }: { data: { token: string; captureId: string } }) => { leases.set(data.token, data); }),
      findFirst: vi.fn(async ({ where }: { where: { token: string } }) => leases.get(where.token)),
      deleteMany: vi.fn(async ({ where }: { where: { token: string } }) => { leases.delete(where.token); })
    }
  };
  const prisma = { ...db, $transaction: async (work: (tx: typeof db) => Promise<unknown>) => work(db) } as unknown as PrismaClient;
  const source = vi.fn(async () => workspaceOutputCollection([{ relativePath: "project/image.png", byteSize: bytes.length,
    checksum: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/png", opaqueFileId: "image",
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) }], undefined));
  const collectOutputs = vi.fn<WorkspaceRuntime["collectOutputs"]>(async input => {
    expect(input.operation).toEqual({ generation: session.version, owner: session.operationOwner });
    return spool.collect(input, source);
  });
  const runtime = { collectOutputs, releaseOutputCapture: (input: Parameters<WorkspaceOutputCaptureStore["release"]>[0]) =>
    spool.release(input) } as unknown as WorkspaceRuntime;
  const service = createWorkspaceSelectedCaptures({ prisma, runtime, storage: createMemoryStorageAdapter(), config });
  const scope = (runId = "subagent") => ({ runId, userId: "user", consumerKey: "tool" });
  const create = (runId = "subagent") => service.create({ ...scope(runId), requestKey: "request",
    files: [{ root: "project", relativePath: "image.png" }] });
  return { attached, bytes, captures, collectOutputs, create, db, operation, prisma, scope, service, session, source };
}

const plan: AvailableVisionAnalysisPlan = { version: 1, available: true, policyVersion: 1, reasoningEffort: null, verifiedVisionInput: true,
  authority: { connectionId: "connection", connectionVersion: 1, providerModelId: "vision", modelVersion: 1, credentialId: "key", credentialVersionId: "key-version" },
  snapshot: { version: 1, connectionId: "connection", connectionDisplayName: "Synthetic vision", providerModelId: "vision", modelDisplayName: "Vision",
    credentialId: "key", credentialVersionId: "key-version", providerFamily: "openai_compatible",
    connection: { apiRoot: "https://vision.example.test/v1", allowPrivateNetwork: false, authenticationMode: "bearer", responseTimeoutMs: 60000 },
    model: { adapterKind: "openai_responses_compatible", modelClass: "answer", upstreamModelId: "vision", answerSelectable: true, defaultParams: {},
      capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, streaming: true, vision: true } } } };

function request(runId: string): ProviderRunRequest {
  return { attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [] },
    modelCapabilities: { contextWindow: 128_000, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, toolCalling: true, vision: true },
    modelId: "vision", params: {}, prompt: { developer: null, system: null }, provider: "fake",
    searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto", visionAnalysis: plan, workspaceImageView: true,
    workspace: { enabled: true, outputDirectory: `/workspace/output/${runId}` } as ProviderRunRequest["workspace"] };
}

describe("selected captures from attached runs", () => {
  it.each(["main", "subagent"])("keeps each capture on its own run when %s holds the shared fence", async owner => {
    const f = await fixture(owner);
    for (const runId of ["main", "subagent"]) {
      const capture = await f.create(runId);
      const row = f.captures.get(capture.id)!;
      expect(row).toMatchObject({ modelRunId: runId, producerOwner: f.operation.owner, producerGeneration: 7,
        selection: { producerOperation: f.operation } });
      expect(f.collectOutputs.mock.calls.at(-1)![0]).toMatchObject({ modelRunId: runId,
        operation: f.operation, selection: { producerOperation: f.operation }, capture: { create: true } });
      const ref = { ...f.scope(runId), captureId: capture.id };
      expect(await f.create(runId)).toEqual(capture);
      const image = await f.service.imageSource({ ...ref, relativePath: "project/image.png" });
      expect(Buffer.from(await new Response(await image.open()).arrayBuffer())).toEqual(f.bytes);
    }
    expect(f.source).toHaveBeenCalledTimes(2);
  });

  it("recovers committed bytes after a lost response and reopens them under a later session fence", async () => {
    const f = await fixture();
    const collect = f.collectOutputs.getMockImplementation()!;
    f.collectOutputs.mockImplementationOnce(async input => {
      const outputs = await collect(input);
      await Promise.all(outputs.map(output => output.body.cancel()));
      throw new Error("synthetic_response_lost");
    });
    await expect(f.create()).rejects.toThrow("synthetic_response_lost");
    const capture = await f.create();
    expect(f.collectOutputs.mock.calls.map(([input]) => input.capture?.create)).toEqual([true, false]);
    f.session.version += 1;
    f.session.operationOwner = "run:subagent";
    const image = await f.service.imageSource({ ...f.scope(), captureId: capture.id, relativePath: "project/image.png" });
    expect(Buffer.from(await new Response(await image.open()).arrayBuffer())).toEqual(f.bytes);
    expect(f.collectOutputs.mock.calls.at(-1)![0]).toMatchObject({
      operation: { generation: 8, owner: "run:subagent" }, selection: { producerOperation: f.operation }, capture: { create: false }
    });
    expect(f.source).toHaveBeenCalledOnce();
  });

  it("refuses a run without a current attachment before creating or reading captures", async () => {
    const f = await fixture();
    const capture = await f.create();
    f.attached.delete("subagent");
    f.collectOutputs.mockClear();
    f.db.workspaceSelectedCapture.create.mockClear();
    await expect(f.create()).rejects.toMatchObject({ code: "workspace_capture_stale" });
    await expect(f.service.openFile({ ...f.scope(), captureId: capture.id, relativePath: "project/image.png" }))
      .rejects.toMatchObject({ code: "workspace_capture_stale" });
    expect(f.db.workspaceSelectedCapture.create).not.toHaveBeenCalled();
    expect(f.collectOutputs).not.toHaveBeenCalled();
  });

  it.each(["main", "subagent"])("lets both runs view and analyze shared pixels when %s holds the fence", async owner => {
    const f = await fixture(owner);
    for (const runId of ["main", "subagent"]) {
      const viewer = createWorkspaceImageViewer({ captures: async () => f.service, request: request(runId), runId, userId: "user",
        budget: createDirectImageBudget(), runEnded: null });
      const viewed = await viewer.execute({ id: "view", name: "view_workspace_image", arguments: { path: "/workspace/project/image.png" } },
        { persistedToolCallId: "view", round: 1 });
      expect(viewed.status).toBe("complete");
      const evidence = parseWorkspaceImageEvidence((viewed.content[1] as { value: unknown }).value)!;
      const preview = viewer.attached({ image: evidence })!.image;
      expect(await sharp(Buffer.from(preview.data, "base64")).removeAlpha().raw().toBuffer()).toEqual(Buffer.from(Array(6).fill([255, 0, 0]).flat()));
      const execute = vi.fn(async (_snapshot: unknown, input: ProviderRunRequest) => {
        const pixels = Buffer.from(input.attachments[0]!.dataUrl!.split(",")[1]!, "base64");
        expect(await sharp(pixels).removeAlpha().raw().toBuffer()).toEqual(Buffer.from(Array(6).fill([255, 0, 0]).flat()));
        return { finalText: "The image is red.", finalProviderResponsePreview: {}, usage: {} };
      });
      const vision = createVisionAnalysisService(f.prisma, f.service, { execute, authorize: async () => true, resolve: async () => plan,
        store: { restore: async () => null, dispatch: async () => ({ result: null }), settle: async (_context, result) => result } });
      const result = await vision.execute({ id: "analyze", name: "analyze_image",
        arguments: { images: [{ path: "/workspace/project/image.png" }], question: "What color is this?" } },
      { runId, userId: "user", persistedToolCallId: "analyze", request: request(runId) });
      expect(result.status).toBe("complete");
      expect(JSON.stringify(result.content)).toContain("The image is red.");
      expect(execute).toHaveBeenCalledOnce();
      expect([...f.captures.values()].filter(capture => capture.modelRunId === runId).map(capture => capture.state))
        .toEqual(["RELEASED", "RELEASED"]);
    }
  });
});
