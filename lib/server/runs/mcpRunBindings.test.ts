import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { insertAcceptedMcpRunBindings } from "./prismaRepository";
import { assertCurrentMcpAdmission } from "./prismaRepositoryPreparation";
import { McpRunPlanConflictError } from "./runRepositoryContract";

type ExecuteRaw = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;

function transaction(executeRaw: ExecuteRaw) {
  return { $executeRaw: executeRaw } as unknown as Pick<Prisma.TransactionClient, "$executeRaw" | "user" | "mcpToolAccessPolicy">;
}

const bindings = [
  {
    fingerprint: "fingerprint-1",
    runtimeGenerationId: "generation-1",
    serverId: "server-1"
  },
  {
    fingerprint: "fingerprint-2",
    runtimeGenerationId: "generation-2",
    serverId: "server-2"
  }
];

/** The value bound right after the SQL fragment that ends with `marker`. */
function boundAfter(strings: readonly string[], values: readonly unknown[], marker: string): unknown {
  const index = strings.findIndex((part) => part.trimEnd().endsWith(marker));
  return index < 0 ? undefined : values[index];
}

type SqlCall = { strings: readonly string[]; values: readonly unknown[] };

/** The personal-server owner fence of one admission query. */
function ownerFence({ strings, values }: SqlCall) {
  const sql = strings.join(" ");
  return {
    installationOnly: /AND server\."ownerUserId" IS NULL(?!\s+OR)/u.test(sql),
    ownerBinding: boundAfter(strings, values, '(server."ownerUserId" IS NULL OR server."ownerUserId" ='),
    ownerComparisons: sql.split('server."ownerUserId"').length - 1
  };
}

describe("MCP admission owner fences", () => {
  const binding = bindings[0]!;
  const expected = { installationOnly: false, ownerBinding: "user-1", ownerComparisons: 2 };

  it("binds accepted runs only to servers that runner may use", async () => {
    const executeRaw = vi.fn<ExecuteRaw>(async () => 1);
    await insertAcceptedMcpRunBindings(transaction(executeRaw), { bindings: [binding], runId: "run-1", tools: [], userId: "user-1" });
    const [first, ...rest] = executeRaw.mock.calls[0]!;
    const call: SqlCall = "strings" in (first as object)
      ? first as unknown as SqlCall
      : { strings: first as readonly string[], values: rest };
    expect(ownerFence(call)).toEqual(expected);
  });

  it("rechecks the same fence at finalization and refuses a missing row", async () => {
    const queryRaw = vi.fn(async (_query: SqlCall): Promise<Array<{ id: string }>> => [{ id: binding.runtimeGenerationId }]);
    const tx = {
      $queryRaw: queryRaw,
      mcpRunBinding: { findMany: async () => [{ runtimeGenerationFingerprint: binding.fingerprint, runtimeGenerationId: binding.runtimeGenerationId }] }
    } as unknown as Prisma.TransactionClient;
    const input = { bindings: [binding], runId: "run-1", tools: [], userId: "user-1" };

    await assertCurrentMcpAdmission(tx, input);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(ownerFence(queryRaw.mock.calls[0]![0])).toEqual(expected);

    queryRaw.mockResolvedValueOnce([]);
    await expect(assertCurrentMcpAdmission(tx, input)).rejects.toBeInstanceOf(McpRunPlanConflictError);
  });
});

describe("atomic MCP run bindings", () => {
  it("uses one guarded INSERT SELECT for every exact prepared binding", async () => {
    const executeRaw = vi.fn<ExecuteRaw>(async () => 1);

    await insertAcceptedMcpRunBindings(transaction(executeRaw), {
      tools: [],
      bindings,
      runId: "run-1",
      userId: "user-1"
    });

    expect(executeRaw).toHaveBeenCalledTimes(2);
    const sql = executeRaw.mock.calls[0]![0].join(" ");
    expect(sql).toContain('INSERT INTO "McpRunBinding"');
    expect(sql).toContain('preference."desiredRuntimeGenerationId" = generation."id"');
    expect(sql).toContain('server."activeRevisionId" = generation."revisionId"');
    expect(sql).toContain('generation."state" = \'ready\'');
    expect(sql).toContain('generation."inventoryUpdatedAt" >= CURRENT_TIMESTAMP');
    expect(sql).toContain('FROM "McpGrant" AS mcp_grant');
    expect(executeRaw.mock.calls[0]).toEqual(expect.arrayContaining([
      "run-1",
      "user-1",
      "server-1",
      "generation-1",
      "fingerprint-1"
    ]));
  });

  it("rejects a stale binding when the guarded insert selects no current generation", async () => {
    const executeRaw = vi.fn<ExecuteRaw>(async () => 0);

    await expect(insertAcceptedMcpRunBindings(transaction(executeRaw), {
      tools: [],
      bindings: [bindings[0]!],
      runId: "run-1",
      userId: "user-1"
    })).rejects.toBeInstanceOf(McpRunPlanConflictError);
  });

  it("rejects duplicate server, generation, or fingerprint identities before writing", async () => {
    for (const duplicate of [
      { ...bindings[1]!, serverId: "server-1" },
      { ...bindings[1]!, runtimeGenerationId: "generation-1" },
      { ...bindings[1]!, fingerprint: "fingerprint-1" }
    ]) {
      const executeRaw = vi.fn<ExecuteRaw>(async () => 1);
      await expect(insertAcceptedMcpRunBindings(transaction(executeRaw), {
      tools: [],
        bindings: [bindings[0]!, duplicate],
        runId: "run-1",
        userId: "user-1"
      })).rejects.toBeInstanceOf(McpRunPlanConflictError);
      expect(executeRaw).not.toHaveBeenCalled();
    }
  });

  it("does not issue SQL when the prepared run has no MCP bindings", async () => {
    const executeRaw = vi.fn<ExecuteRaw>(async () => 1);

    await insertAcceptedMcpRunBindings(transaction(executeRaw), {
      tools: [],
      bindings: undefined,
      runId: "run-1",
      userId: "user-1"
    });

    expect(executeRaw).not.toHaveBeenCalled();
  });
});
