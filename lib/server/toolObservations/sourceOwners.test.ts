import type { Prisma, ToolObservation } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createObservationSourceOwners } from "./sourceOwners";

type Grant = Readonly<{ enabled?: boolean; searchStrategy: string }>;

/** A saved long search result of one run, read back by its user with the given Search grants. */
function harness(input: Readonly<{ grants: readonly Grant[]; mode: string; revision?: boolean }>) {
  const findFirst = vi.fn(async () => (input.revision === false ? null : { id: "revision-1" }));
  const tx = {
    $queryRaw: vi.fn(async () => [{ mode: input.mode, options: [{ optionId: "deepseek", revisionId: "revision-1", use: "engine" }] }]),
    accessGrant: { findMany: vi.fn(async () => input.grants.map((grant) => ({ enabled: grant.enabled ?? true, groupId: null,
      providerConnectionId: null, providerModel: null, providerModelId: null, searchStrategy: grant.searchStrategy, userId: "user" }))) },
    modelRun: { findUnique: vi.fn(async () => ({ id: "run", subagentTurn: null })) },
    searchIntegrationRevision: { findFirst },
    userGroup: { findMany: vi.fn(async () => []) }
  };
  const source = {
    modelRunId: "run",
    sourceBinding: { source: "search", sources: [{ optionId: "deepseek", revisionId: "revision-1" }], version: 1 },
    sourceKind: "search",
    state: "READY",
    toolCallId: "call"
  } as unknown as ToolObservation;
  const authorize = () => createObservationSourceOwners()
    .authorizeSource(tx as unknown as Prisma.TransactionClient, source, { runId: "reader-run", userId: "user" });
  return { authorize, findFirst };
}

describe("search observation owners", () => {
  it("lets a single-engine run's user reread its long result with a grant for another source", async () => {
    await expect(harness({ grants: [{ searchStrategy: "openrouter-perplexity" }], mode: "engine" }).authorize()).resolves.toBeUndefined();
  });

  it.each([
    ["no Search grant", []],
    ["only a disabled grant", [{ enabled: false, searchStrategy: "deepseek" }]],
    ["only Search disabled", [{ searchStrategy: "search-disabled" }]]
  ])("refuses a single-engine run's result to a user with %s", async (_name, grants) => {
    await expect(harness({ grants, mode: "engine" }).authorize()).rejects.toMatchObject({ code: "tool_observation_unavailable" });
  });

  it("still needs the source's live revision on a single-engine run", async () => {
    const { authorize, findFirst } = harness({ grants: [{ searchStrategy: "deepseek" }], mode: "engine", revision: false });
    await expect(authorize()).rejects.toMatchObject({ code: "tool_observation_unavailable" });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "revision-1" }) }));
  });

  it("keeps a pre-upgrade run's result behind the grant of the source it called", async () => {
    await expect(harness({ grants: [{ searchStrategy: "openrouter-perplexity" }], mode: "all_selected" }).authorize())
      .rejects.toMatchObject({ code: "tool_observation_unavailable" });
    await expect(harness({ grants: [{ searchStrategy: "deepseek" }], mode: "all_selected" }).authorize()).resolves.toBeUndefined();
  });
});
