import { ModelRunStatus, Prisma } from "@prisma/client";
import type { ProjectChatSummaryWire } from "@/lib/contracts/projects";
import type {
  WorkspaceAvailabilityService,
  WorkspaceAvailabilitySnapshot
} from "@/lib/server/workspace/availability";
import {
  projectChatDefaultsProjection,
  type ProjectChatDefaultAuthority
} from "./chatDefaults";

export const projectChatSelect = {
  _count: {
    select: {
      messages: true,
      modelRuns: {
        where: {
          status: {
            in: [
              ModelRunStatus.preparing,
              ModelRunStatus.queued,
              ModelRunStatus.streaming,
              ModelRunStatus.in_progress
            ]
          }
        }
      }
    }
  },
  activeLeafMessageId: true,
  archived: true,
  createdAt: true,
  createdByDisplayName: true,
  createdByUserId: true,
  defaultKnowledgePlan: true,
  defaultProviderModel: {
    select: {
      activeConfig: true,
      activeVersion: true,
      connectionId: true,
      enabled: true,
      id: true,
      modelClass: true
    }
  },
  id: true,
  pinned: true,
  projectFolderId: true,
  projectId: true,
  title: true,
  updatedAt: true,
  workspaceEnabled: true,
  workspaceSession: {
    select: {
      internetEnabled: true,
      state: true
    }
  }
} satisfies Prisma.ChatSelect;

export type ProjectChatRow = Prisma.ChatGetPayload<{ select: typeof projectChatSelect }>;

export function projectChatWire(
  chat: ProjectChatRow,
  authority: ProjectChatDefaultAuthority,
  workspace: Readonly<{
    availability: WorkspaceAvailabilityService;
    snapshot: WorkspaceAvailabilitySnapshot;
  }>
): ProjectChatSummaryWire {
  if (!chat.projectId) throw new Error("project_chat_integrity_invalid");
  const defaults = projectChatDefaultsProjection(authority, {
    defaultKnowledgePlan: chat.defaultKnowledgePlan,
    defaultModelId: chat.defaultProviderModel?.id ?? null
  });
  return {
    activeRun: chat._count.modelRuns > 0,
    activeLeafMessageId: chat.activeLeafMessageId,
    archived: chat.archived,
    createdAt: chat.createdAt.toISOString(),
    createdByDisplayName: chat.createdByDisplayName,
    createdByUserId: chat.createdByUserId,
    defaultKnowledgePlan: defaults.defaultKnowledgePlan,
    defaultModelId: defaults.defaultModelId,
    defaultProvider: defaults.defaultProvider,
    folderId: chat.projectFolderId,
    id: chat.id,
    messageCount: chat._count.messages,
    pinned: chat.pinned,
    projectId: chat.projectId,
    title: chat.title,
    updatedAt: chat.updatedAt.toISOString(),
    workspace: workspace.availability.project(workspace.snapshot, {
      enabled: chat.workspaceEnabled,
      modelSupportsTools: defaults.defaultModelId !== null &&
        authority.toolCallingModelIds.has(defaults.defaultModelId),
      session: chat.workspaceSession
    })
  };
}
