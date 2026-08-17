import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { insertAcceptedMcpRunBindings } from "./prismaRepository";
import { McpRunPlanConflictError } from "./runRepositoryContract";

type ExecuteRaw = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;

function transaction(executeRaw: ExecuteRaw) {
  return { $executeRaw: executeRaw } as unknown as Pick<Prisma.TransactionClient, "$executeRaw">;
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

describe("atomic MCP run bindings", () => {
  it("uses Project authority and shared-current runtime fences without a personal grant", async () => {
    const executeRaw = vi.fn<ExecuteRaw>(async () => 1);

    await insertAcceptedMcpRunBindings(transaction(executeRaw), {
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
    expect(sql).toContain('preference."desiredRuntimeGenerationId" = generation."id"');
    expect(sql).toContain('preference."personalConfigEnvelope" IS NULL');
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
      bindings: undefined,
      runId: "run-1",
      userId: "user-1"
    });

    expect(executeRaw).not.toHaveBeenCalled();
  });
});
