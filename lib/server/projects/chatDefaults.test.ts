import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  loadProjectChatDefaultAuthority,
  projectChatDefaultsProjection
} from "./chatDefaults";

function answerModel(input: { available?: boolean; family?: string; id: string }) {
  return {
    providerModel: {
      activeConfig: { adapterKind: input.family === "fake" ? "fake" : "openai_responses" },
      activeVersion: 1,
      availableInProjects: input.available ?? true,
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
      enabled: true,
      id: input.id,
      modelClass: "answer"
    }
  };
}

function knowledgeBase(input: { available?: boolean; id: string }) {
  return {
    knowledgeBase: {
      activeIndexGeneration: {
        embeddingProviderModel: {
          activeConfig: {},
          activeVersion: 1,
          availableInProjects: input.available ?? true,
          connection: {
            activeConfig: {},
            activeVersion: 1,
            defaultCredential: { activeVersion: { revokedAt: null }, enabled: true },
            enabled: true,
            family: "openai"
          },
          enabled: true,
          modelClass: "embedding"
        },
        status: "active"
      },
      archivedAt: null,
      id: input.id
    }
  };
}

describe("Project chat default projection", () => {
  it("keeps only currently runnable Project authority", async () => {
    const prisma = {
      projectKnowledgeBaseBinding: {
        findMany: vi.fn().mockResolvedValue([
          knowledgeBase({ id: "knowledge-safe" }),
          knowledgeBase({ available: false, id: "knowledge-revoked" })
        ])
      },
      projectModelBinding: {
        findMany: vi.fn().mockResolvedValue([
          answerModel({ family: "fake", id: "model-safe" }),
          answerModel({ available: false, id: "model-revoked" })
        ])
      }
    } as unknown as PrismaClient;

    const authority = await loadProjectChatDefaultAuthority(prisma, "project-1");
    expect(projectChatDefaultsProjection(authority, {
      defaultKnowledgePlan: { baseIds: ["knowledge-safe", "knowledge-revoked"] },
      defaultModelId: "model-safe"
    })).toEqual({
      defaultKnowledgePlan: { baseIds: ["knowledge-safe"] },
      defaultModelId: "model-safe",
      defaultProvider: "connection:model-safe"
    });
    expect(projectChatDefaultsProjection(authority, {
      defaultKnowledgePlan: { baseIds: ["knowledge-revoked"] },
      defaultModelId: "model-revoked"
    })).toEqual({
      defaultKnowledgePlan: { baseIds: [] },
      defaultModelId: null,
      defaultProvider: null
    });
  });
});
