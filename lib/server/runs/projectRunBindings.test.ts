import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "../knowledge/knowledgeBudget";
import type { KnowledgeRunAdmissionPlan } from "../knowledge/runAdmission";
import {
  assertProjectAssistantRunProvenance,
  insertAcceptedSkillRunBindings,
  lockKnowledgeRunAdmissionSources
} from "./prismaRepositoryBindings";

type QueryRaw = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
type ExecuteRaw = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;

describe("Project-scoped run binding locks", () => {
  it("uses the exact Project Assistant publication without personal grants", async () => {
    const queryRaw = vi.fn<QueryRaw>(async () => [{ id: "project-assistant-binding" }]);

    await assertProjectAssistantRunProvenance(
      { $queryRaw: queryRaw } as unknown as Pick<Prisma.TransactionClient, "$queryRaw">,
      {
        assistantId: "assistant-1",
        projectId: "project-1",
        revisionId: "assistant-revision-1"
      }
    );

    const call = queryRaw.mock.calls[0]!;
    const sql = (call[0] as unknown as readonly string[]).join(" ");
    expect(sql).toContain('FROM "ProjectAssistantBinding"');
    expect(sql).toContain('definition."archivedAt" IS NULL');
    expect(sql).not.toContain('"AssistantPublication"');
    expect(sql).not.toContain('definition."ownerUserId"');
    expect(call).toEqual(expect.arrayContaining([
      "project-1",
      "assistant-1",
      "assistant-revision-1"
    ]));
  });

  it("locks Project Knowledge authority without consulting the contributor's publications", async () => {
    const queryRaw = vi.fn<QueryRaw>(async () => [{ id: "project-knowledge-binding" }]);
    const plan = {
      bindings: [{
        baseContentRevision: 1,
        embeddingCredentialSource: "default",
        embeddingExecutionSnapshot: {} as never,
        embeddingProviderModelId: "embedding-model-1",
        includeWholeBase: true,
        indexedContentRevision: 1,
        indexGenerationId: "generation-1",
        knowledgeBaseId: "knowledge-1",
        ordinal: 0,
        selectedSourceIds: [],
        targetDimension: 1024,
        vectorSpaceFingerprint: "a".repeat(64)
      }],
      budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
      executionScope: "project",
      exclusions: [],
      fingerprint: "fingerprint",
      knowledgePlan: {
        baseIds: ["knowledge-1"], mode: "explicit", sourceIds: [], version: 1
      },
      projectId: "project-1",
      resolvedSourceCount: 0,
      userId: "contributor-without-personal-access"
    } satisfies KnowledgeRunAdmissionPlan;

    await lockKnowledgeRunAdmissionSources(
      { $queryRaw: queryRaw } as unknown as Pick<Prisma.TransactionClient, "$queryRaw">,
      { plan, userId: plan.userId }
    );

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const call = queryRaw.mock.calls[0]!;
    const sql = (call[0] as unknown as readonly string[]).join(" ");
    expect(sql).toContain('FROM "ProjectKnowledgeBaseBinding"');
    expect(sql).toContain('generation."status" = \'active\'');
    expect(sql).not.toContain('"KnowledgeBasePublication"');
    expect(sql).not.toContain('base."ownerUserId"');
    expect(call).toEqual(expect.arrayContaining(["project-1", "knowledge-1"]));
  });

  it("inserts a Project Skill binding without importing personal Skill publication", async () => {
    const executeRaw = vi.fn<ExecuteRaw>(async () => 1);

    await insertAcceptedSkillRunBindings(
      { $executeRaw: executeRaw, $queryRaw: vi.fn() } as unknown as Pick<
        Prisma.TransactionClient,
        "$executeRaw" | "$queryRaw"
      >,
      {
        bindings: [{ revisionId: "skill-revision-1", skillId: "skill-1" }],
        projectId: "project-1",
        runId: "run-1",
        userId: "contributor-without-personal-access"
      }
    );

    const call = executeRaw.mock.calls[0]!;
    const sql = (call[0] as unknown as readonly string[]).join(" ");
    expect(sql).toContain('INNER JOIN "ProjectSkillBinding"');
    expect(sql).toContain('definition."currentRevisionId"');
    expect(sql).not.toContain('"SkillPublication"');
    expect(call).toEqual(expect.arrayContaining([
      "project-1",
      "skill-1",
      "skill-revision-1",
      "run-1",
      "contributor-without-personal-access"
    ]));
  });
});
