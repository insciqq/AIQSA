import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  WORKSPACE_INBOX_INDEX_PATH,
  WORKSPACE_PROJECT_DIRECTORY,
  WORKSPACE_POLICY_ID,
  workspaceMessageManifestPath,
  workspaceRunOutputDirectory,
  workspaceSandboxName
} from "@/lib/domain/workspace";
import type { NormalizedRunWorkspace } from "@/lib/server/providers/types";
import type { RunTool } from "@/lib/server/tools/types";
import type { WorkspaceConfig } from "./config";
import type { WorkspaceHealthService } from "./health";
import { loadPinnedOfficialWorkspaceToolCatalog } from "./microsandboxRuntime";
import type { WorkspacePolicyRepository } from "./policyRepository";
import type { WorkspaceBoundTool, WorkspaceToolCatalog } from "./runtime";

export type WorkspaceAdmissionErrorCode =
  | "workspace_disabled"
  | "workspace_model_tools_required"
  | "workspace_runtime_incompatible"
  | "workspace_runtime_unavailable";

export type WorkspaceAdmissionFailure = Readonly<{
  code: WorkspaceAdmissionErrorCode;
  ok: false;
  status: 400 | 409 | 503;
}>;

export type WorkspaceRunAdmissionPlan = Readonly<{
  assistantMessageId: string;
  chatId: string;
  expiresAt: string;
  normalized: NormalizedRunWorkspace;
  policyRevision: number;
  runId: string;
  sandboxName: string;
  sessionId: string;
  toolDefinitions: readonly WorkspaceBoundTool[];
  userMessageId: string;
}>;

export type WorkspaceAdmissionResult = WorkspaceAdmissionFailure | Readonly<{
  ok: true;
  plan: WorkspaceRunAdmissionPlan;
  tools: readonly RunTool[];
}>;

export type WorkspaceAdmissionService = Readonly<{
  prepare(input: Readonly<{
    assistantMessageId: string;
    chatId: string;
    enabled: boolean;
    modelSupportsTools: boolean;
    runId: string;
    signal?: AbortSignal;
    userMessageId: string;
  }>): Promise<WorkspaceAdmissionResult>;
}>;

type SessionSnapshot = Readonly<{
  id: string;
  imageRef: string;
  internetEnabled: boolean;
  sandboxName: string;
}>;

export type WorkspaceAdmissionRepository = Readonly<{
  findSession(chatId: string): Promise<SessionSnapshot | null>;
}>;

let pinnedCatalog: Promise<WorkspaceToolCatalog> | null = null;

function loadCatalog(): Promise<WorkspaceToolCatalog> {
  pinnedCatalog ??= loadPinnedOfficialWorkspaceToolCatalog().catch((error) => {
    pinnedCatalog = null;
    throw error;
  });
  return pinnedCatalog;
}

function deterministicSessionId(chatId: string): string {
  return `ws_${createHash("sha256").update(`aiqsa-workspace\0${chatId}`).digest("hex").slice(0, 40)}`;
}

export function workspaceRunTools(
  definitions: readonly WorkspaceBoundTool[]
): RunTool[] {
  return definitions.map((tool) => ({
    capability: "workspace" as const,
    description: tool.description,
    inputSchema: tool.inputSchema,
    name: tool.namespacedName
  }));
}

export function createPrismaWorkspaceAdmissionRepository(
  prisma: Pick<PrismaClient, "workspaceSession">
): WorkspaceAdmissionRepository {
  return {
    findSession(chatId) {
      return prisma.workspaceSession.findUnique({
        select: {
          id: true,
          imageRef: true,
          internetEnabled: true,
          sandboxName: true
        },
        where: { chatId }
      });
    }
  };
}

export function createWorkspaceAdmissionService(input: Readonly<{
  config: WorkspaceConfig;
  health: WorkspaceHealthService;
  now?: () => Date;
  policy: WorkspacePolicyRepository;
  repository: WorkspaceAdmissionRepository;
}>): WorkspaceAdmissionService {
  const now = input.now ?? (() => new Date());
  return {
    async prepare(request) {
      if (!request.enabled) {
        return { code: "workspace_disabled", ok: false, status: 409 };
      }
      if (!request.modelSupportsTools) {
        return { code: "workspace_model_tools_required", ok: false, status: 400 };
      }
      const [policy, health, existing] = await Promise.all([
        input.policy.read(),
        input.health.read({ fresh: true }),
        input.repository.findSession(request.chatId)
      ]).catch(() => [null, null, null] as const);
      if (!policy?.enabled) {
        return { code: "workspace_disabled", ok: false, status: 409 };
      }
      if (health?.state !== "ready") {
        return { code: "workspace_runtime_unavailable", ok: false, status: 503 };
      }

      let catalog: WorkspaceToolCatalog;
      try {
        catalog = await loadCatalog();
      } catch {
        return { code: "workspace_runtime_incompatible", ok: false, status: 503 };
      }
      if (
        catalog.runtimeVersion !== health.runtimeVersion ||
        catalog.mcpVersion !== health.mcpVersion
      ) {
        return { code: "workspace_runtime_incompatible", ok: false, status: 503 };
      }

      const sessionId = existing?.id ?? deterministicSessionId(request.chatId);
      const sandboxName = existing?.sandboxName ?? workspaceSandboxName(sessionId);
      const imageRef = existing?.imageRef ?? input.config.imageRef;
      const internetEnabled = existing?.internetEnabled ?? policy.internetEnabled;
      const normalized: NormalizedRunWorkspace = {
        enabled: true,
        imageRef,
        inboxIndexPath: WORKSPACE_INBOX_INDEX_PATH,
        internetEnabled,
        mcpVersion: catalog.mcpVersion,
        maxToolCalls: input.config.maxToolCalls,
        maxToolRounds: input.config.maxToolRounds,
        messageManifestPath: workspaceMessageManifestPath(request.userMessageId),
        outputDirectory: workspaceRunOutputDirectory(request.runId),
        projectDirectory: WORKSPACE_PROJECT_DIRECTORY,
        runtimeVersion: catalog.runtimeVersion,
        sessionId,
        syncToolTimeoutSeconds: input.config.syncToolTimeoutSeconds,
        toolCatalogHash: catalog.hash,
        turnTimeoutSeconds: input.config.turnTimeoutSeconds
      };
      const admittedAt = now();
      const plan: WorkspaceRunAdmissionPlan = {
        assistantMessageId: request.assistantMessageId,
        chatId: request.chatId,
        expiresAt: new Date(
          admittedAt.getTime() + input.config.retentionSeconds * 1_000
        ).toISOString(),
        normalized,
        policyRevision: policy.version,
        runId: request.runId,
        sandboxName,
        sessionId,
        toolDefinitions: catalog.tools,
        userMessageId: request.userMessageId
      };
      return { ok: true, plan, tools: workspaceRunTools(catalog.tools) };
    }
  };
}

export async function assertWorkspacePolicySnapshot(
  tx: Pick<PrismaClient, "workspacePolicy">,
  plan: WorkspaceRunAdmissionPlan
): Promise<void> {
  const policy = await tx.workspacePolicy.findUnique({
    select: { enabled: true, version: true },
    where: { id: WORKSPACE_POLICY_ID }
  });
  if (!policy?.enabled || policy.version !== plan.policyRevision) {
    throw new WorkspaceAdmissionConflictError("workspace_disabled");
  }
}

export class WorkspaceAdmissionConflictError extends Error {
  readonly code: "workspace_busy" | "workspace_disabled" | "workspace_runtime_incompatible";

  constructor(code: WorkspaceAdmissionConflictError["code"]) {
    super(code);
    this.code = code;
    this.name = "WorkspaceAdmissionConflictError";
  }
}
