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

  it.each([
    ["Project", { projectId: "project-1" }, { installationOnly: true, ownerBinding: undefined, ownerComparisons: 1 }],
    ["personal", {}, { installationOnly: false, ownerBinding: "user-1", ownerComparisons: 2 }]
  ] as const)("binds accepted %s runs only to servers that runner may use", async (_label, scope, expected) => {
    const executeRaw = vi.fn<ExecuteRaw>(async () => 1);
    await insertAcceptedMcpRunBindings(transaction(executeRaw), { ...scope, bindings: [binding], runId: "run-1", tools: [], userId: "user-1" });
    const [first, ...rest] = executeRaw.mock.calls[0]!;
    const call: SqlCall = "strings" in (first as object)
      ? first as unknown as SqlCall
      : { strings: first as readonly string[], values: rest };
    expect(ownerFence(call)).toEqual(expected);
  });

  it.each([
    ["Project", { projectId: "project-1" }, { installationOnly: true, ownerBinding: undefined, ownerComparisons: 1 }],
    ["personal", {}, { installationOnly: false, ownerBinding: "user-1", ownerComparisons: 2 }]
  ] as const)("rechecks the same fence for %s runs at finalization and refuses a missing row", async (_label, scope, expected) => {
    const queryRaw = vi.fn(async (_query: SqlCall): Promise<Array<{ id: string }>> => [{ id: binding.runtimeGenerationId }]);
    const tx = {
      $queryRaw: queryRaw,
      mcpRunBinding: { findMany: async () => [{ runtimeGenerationFingerprint: binding.fingerprint, runtimeGenerationId: binding.runtimeGenerationId }] }
    } as unknown as Prisma.TransactionClient;
    const input = { ...scope, bindings: [binding], runId: "run-1", tools: [], userId: "user-1" };

    await assertCurrentMcpAdmission(tx, input);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(ownerFence(queryRaw.mock.calls[0]![0])).toEqual(expected);

    queryRaw.mockResolvedValueOnce([]);
    await expect(assertCurrentMcpAdmission(tx, input)).rejects.toBeInstanceOf(McpRunPlanConflictError);
  });
});

describe("atomic MCP run bindings", () => {
  it("uses Project authority and shared-current runtime fences without a personal grant", async () => {
    const executeRaw = vi.fn<ExecuteRaw>(async () => 1);

    await insertAcceptedMcpRunBindings(transaction(executeRaw), {
      tools: [],
      bindings: [bindings[0]!],
      projectId: "project-1",
      runId: "run-1",
      userId: "contributor-without-grant"
    });

    expect(executeRaw).toHaveBeenCalledTimes(1);
    const query = executeRaw.mock.calls[0]![0] as unknown as {
      join?: (separator: string) => string;
      strings?: readonly string[];
    };
    const sql = query.strings?.join(" ") ?? query.join?.(" ") ?? "";
    expect(sql).toContain('INNER JOIN "ProjectMcpBinding"');
    // Only the server's installation-owned shared runtime, never a member's generation.
    expect(sql).toContain('shared."desiredRuntimeGenerationId" = generation."id"');
    expect(sql).toContain('shared."serverId" = generation."sharedServerId"');
    expect(sql).toContain('generation."userServerId" IS NULL');
    expect(sql).not.toContain('"McpUserServer"');
    expect(sql).toContain('generation."oauthConnectionId" IS NULL');
    expect(sql).toContain("ARRAY['oauth', 'personal']");
    expect(sql).not.toContain('FROM "McpGrant"');
    expect((query as { values?: readonly unknown[] }).values).toEqual(expect.arrayContaining([
      "project-1",
      "server-1",
      "generation-1",
      "fingerprint-1"
    ]));
  });

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
