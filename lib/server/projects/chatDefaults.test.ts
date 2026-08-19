import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  loadProjectChatDefaultAuthority,
  projectChatDefaultsProjection
} from "./chatDefaults";

function answerModel(input: { enabled?: boolean; family?: string; id: string }) {
  return {
    providerModel: {
      activeConfig: { adapterKind: input.family === "fake" ? "fake" : "openai_responses" },
      activeVersion: 1,
      connection: {
        activeConfig: {},
        activeVersion: 1,
        defaultCredential: input.family === "fake"
          ? null
          : { activeVersion: { revokedAt: null }, enabled: true },
        enabled: true,
        family: input.family ?? "openai"
      },
      connectionId: `connection:${input.id}`,
      enabled: input.enabled ?? true,
      id: input.id,
      modelClass: "answer"
    }
  };
}

function knowledgeBase(input: { enabled?: boolean; id: string; sourceId?: string }) {
  return {
    knowledgeBase: {
      activeIndexGeneration: {
        embeddingProviderModel: {
          activeConfig: {},
          activeVersion: 1,
          connection: {
            activeConfig: {},
            activeVersion: 1,
            defaultCredential: { activeVersion: { revokedAt: null }, enabled: true },
            enabled: true,
            family: "openai"
          },
          enabled: input.enabled ?? true,
          modelClass: "embedding"
        },
        profileRevisionId: "profile-1",
        status: "active"
      },
      archivedAt: null,
      id: input.id,
      sourceMemberships: input.sourceId ? [{
        source: {
          currentVersion: {
            artifacts: [{
              hierarchicalIndexes: [{ state: "ready" }],
              profileRevisionId: "profile-1",
              state: "ready"
            }]
          }
        },
        sourceId: input.sourceId
      }] : []
    }
  };
}

describe("Project chat default projection", () => {
  it("keeps only currently runnable Project authority", async () => {
    const prisma = {
      projectKnowledgeBaseBinding: {
        findMany: vi.fn().mockResolvedValue([
          knowledgeBase({ id: "knowledge-safe", sourceId: "source-safe" }),
          knowledgeBase({ enabled: false, id: "knowledge-revoked" })
        ])
      },
      projectModelBinding: {
        findMany: vi.fn().mockResolvedValue([
          answerModel({ family: "fake", id: "model-safe" }),
          answerModel({ enabled: false, id: "model-revoked" })
        ])
      }
    } as unknown as PrismaClient;

    const authority = await loadProjectChatDefaultAuthority(prisma, "project-1");
    expect(projectChatDefaultsProjection(authority, {
      defaultKnowledgePlan: {
        baseIds: ["knowledge-safe", "knowledge-revoked"],
        mode: "explicit",
        sourceIds: ["source-safe", "source-revoked"],
        version: 1
      },
      defaultModelId: "model-safe"
    })).toEqual({
      defaultKnowledgePlan: {
        baseIds: ["knowledge-safe"],
        mode: "explicit",
        sourceIds: ["source-safe"],
        version: 1
      },
      defaultModelId: "model-safe",
      defaultProvider: "connection:model-safe"
    });
    expect(projectChatDefaultsProjection(authority, {
      defaultKnowledgePlan: {
        baseIds: ["knowledge-revoked"],
        mode: "explicit",
        sourceIds: ["source-revoked"],
        version: 1
      },
      defaultModelId: "model-revoked"
    })).toEqual({
      defaultKnowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      defaultModelId: null,
      defaultProvider: null
    });
  });
});
