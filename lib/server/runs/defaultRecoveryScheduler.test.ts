import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const storage = { kind: "storage" };
  const service = (kind: string) => vi.fn((input: unknown) => ({ kind, storage: input }));
  return {
    artifacts: service("artifacts"),
    images: service("images"),
    reconcile: vi.fn(async (_deps: Record<string, unknown>) => undefined),
    schedulerInput: [] as Array<{ reconcile(signal: AbortSignal): Promise<void> }>,
    skillTools: { kind: "skillTools" },
    storage,
    vision: service("vision"),
    workspace: service("workspace")
  };
});

vi.mock("../artifacts/defaultArtifacts", () => ({ artifactServiceForStorage: mocks.artifacts }));
vi.mock("../images/defaultImages", () => ({ imageGenerationForStorage: mocks.images }));
vi.mock("../vision/defaultVision", () => ({ visionAnalysisForStorage: mocks.vision }));
vi.mock("../skills/defaultSkillTools", () => ({ defaultSkillTools: mocks.skillTools }));
vi.mock("../knowledge/defaultEvidenceDispatch", () => ({ knowledgeProviderDispatchLifecycle: { kind: "knowledgeProviderDispatch" } }));
vi.mock("../knowledge/defaultRetrieval", () => ({ knowledgeToolExecutor: { kind: "knowledgeExecutor" } }));
vi.mock("../knowledge/runAdmission", () => ({ knowledgeRunAdmissionService: { kind: "knowledgeAdmission" } }));
vi.mock("../mcp/defaultRuntime", () => ({ defaultMcpRunPlan: { kind: "mcp" } }));
vi.mock("../memory/egress/receipts", () => ({ defaultMemoryToolEgressReceiptService: { kind: "memoryEgress" } }));
vi.mock("../providerRuntime/defaultAdmission", () => ({ providerAdmissionService: { kind: "providerAdmission" } }));
vi.mock("../providerRuntime/defaultRuntime", () => ({ providerRuntimeResolver: { kind: "providerRuntime" } }));
vi.mock("../uploads/storage", () => ({ createS3StorageAdapter: () => mocks.storage }));
vi.mock("../workspace/defaultServices", () => ({ workspaceCoordinatorForStorage: mocks.workspace }));
vi.mock("../workspace/checkpoints", () => ({ defaultWorkspaceCheckpoints: vi.fn() }));
vi.mock("../uploads/defaultChatPdf", () => ({ getDefaultChatPdf: () => ({ kick: vi.fn() }) }));
vi.mock("./defaultWorkspaceFollowup", () => ({ getDefaultWorkspaceFollowup: () => ({ kick: vi.fn() }) }));
vi.mock("../chats/titleGenerationWorker", () => ({ createPrismaChatTitleWorker: () => ({ reconcile: vi.fn() }) }));
vi.mock("./runExecution", () => ({ activeRunControllerRegistry: { kind: "registry" } }));
vi.mock("./prismaRepository", () => ({ createPrismaRunRepository: () => ({ kind: "repository" }) }));
vi.mock("./runRecovery", () => ({ reconcileInstallationRuns: mocks.reconcile }));
vi.mock("./recoveryScheduler", () => ({
  RunRecoveryScheduler: class {
    constructor(input: { reconcile(signal: AbortSignal): Promise<void> }) { mocks.schedulerInput.push(input); }
  }
}));

import { getDefaultRunRecoveryScheduler } from "./defaultRecoveryScheduler";

afterEach(() => {
  delete (globalThis as { __aiqsaRunRecoveryScheduler?: unknown }).__aiqsaRunRecoveryScheduler;
});

describe("default run recovery scheduler", () => {
  it("recovers runs with the same tool services and dispatch policies as the run routes", async () => {
    getDefaultRunRecoveryScheduler();
    await mocks.schedulerInput[0]!.reconcile(new AbortController().signal);

    expect(mocks.reconcile).toHaveBeenCalledOnce();
    const deps = mocks.reconcile.mock.calls[0]![0];
    // Undispatched image, artifact and Skill calls, running artifact/image
    // receipts and conversation pixels all depend on these services.
    expect(deps).toMatchObject({
      artifacts: { kind: "artifacts", storage: mocks.storage },
      images: { kind: "images", storage: mocks.storage },
      skillTools: mocks.skillTools,
      vision: { kind: "vision", storage: mocks.storage },
      knowledgeAdmission: { kind: "knowledgeAdmission" },
      knowledgeExecutor: { kind: "knowledgeExecutor" },
      knowledgeProviderDispatch: { kind: "knowledgeProviderDispatch" },
      memoryEgress: { kind: "memoryEgress" },
      mcp: { kind: "mcp" },
      providerAdmission: { kind: "providerAdmission" },
      providerRuntime: { kind: "providerRuntime" },
      providers: {},
      registry: { kind: "registry" },
      repository: { kind: "repository" },
      storage: mocks.storage,
      workspace: { kind: "workspace", storage: mocks.storage }
    });
  });
});
