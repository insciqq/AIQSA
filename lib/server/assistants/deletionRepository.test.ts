import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createPrismaAssistantDeletionRepository } from "./deletionRepository";
import { createPrismaAssistantRepository } from "./prismaRepository";

function unknownPostgres(code: string): Prisma.PrismaClientUnknownRequestError {
  return new Prisma.PrismaClientUnknownRequestError(
    `ConnectorError(QueryError(PostgresError { code: "${code}", message: "safe" }))`,
    { clientVersion: "6.19.3" }
  );
}

function knownPostgres(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("safe", {
    clientVersion: "6.19.3",
    code: "P2010",
    meta: { code }
  });
}

/** Fails the first transactions, then commits a deletion that touched one Project. */
function clientWithFailures(...failures: unknown[]) {
  const queued = [...failures];
  const transaction = vi.fn(async () => {
    const failure = queued.shift();
    if (failure) throw failure;
    return { kind: "deleted" as const, projectIds: ["project-1"] };
  });
  const notifyProjectEvent = vi.fn();
  const repository = createPrismaAssistantDeletionRepository(
    { $transaction: transaction } as unknown as PrismaClient,
    { notifyProjectEvent }
  );
  return { notifyProjectEvent, repository, transaction };
}

describe("Prisma Assistant deletion retries", () => {
  it.each(["delete", "archive"] as const)("locks the owner before the definition for %s", async (operation) => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const tx = { $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ text: strings.join(""), values });
      return [];
    }) };
    const client = { $transaction: async (apply: (value: typeof tx) => Promise<unknown>) => apply(tx) } as unknown as PrismaClient;
    const result = operation === "delete"
      ? await createPrismaAssistantDeletionRepository(client).delete("owner", "assistant", 3)
      : await createPrismaAssistantRepository(client).setArchived("owner", "assistant", 3, true);

    expect(result).toEqual({ kind: "not_found" });
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({ text: expect.stringContaining('FROM "User"'), values: ["owner"] });
    expect(queries[0]?.text).toContain("FOR UPDATE");
    expect(queries[1]).toMatchObject({
      text: expect.stringContaining('FROM "AssistantDefinition"'), values: ["assistant", "owner"]
    });
    expect(queries[1]?.text).toContain('"ownerUserId"');
  });

  it.each([
    ["an unknown-request deadlock", unknownPostgres("40P01")],
    ["an unknown-request serialization failure", unknownPostgres("40001")],
    ["a raw-query deadlock", knownPostgres("40P01")],
    ["a transaction conflict", new Prisma.PrismaClientKnownRequestError("safe", {
      clientVersion: "6.19.3",
      code: "P2034"
    })]
  ])("retries %s and notifies only after the committed attempt", async (_label, failure) => {
    const { notifyProjectEvent, repository, transaction } = clientWithFailures(failure);

    await expect(repository.delete("owner", "assistant", 3)).resolves.toEqual({ kind: "deleted" });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(notifyProjectEvent).toHaveBeenCalledTimes(1);
    expect(notifyProjectEvent).toHaveBeenCalledWith("project-1");
  });

  it("answers a version conflict after three conflicting attempts", async () => {
    const { notifyProjectEvent, repository, transaction } = clientWithFailures(
      unknownPostgres("40P01"),
      unknownPostgres("40001"),
      knownPostgres("40P01")
    );

    await expect(repository.delete("owner", "assistant", 3)).resolves.toEqual({ kind: "version_conflict" });
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(notifyProjectEvent).not.toHaveBeenCalled();
  });

  it("does not retry an unrelated database failure", async () => {
    const failure = unknownPostgres("23503");
    const { repository, transaction } = clientWithFailures(failure);

    await expect(repository.delete("owner", "assistant", 3)).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
