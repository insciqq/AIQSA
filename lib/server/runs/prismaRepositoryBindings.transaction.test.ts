import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { repeatableReadTransaction } from "./prismaRepositoryBindings";

function clientWithFailures(...failures: unknown[]): Readonly<{
  client: PrismaClient;
  transaction: ReturnType<typeof vi.fn>;
}> {
  const queued = [...failures];
  const transaction = vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => {
    const failure = queued.shift();
    if (failure) throw failure;
    return operation({});
  });
  return { client: { $transaction: transaction } as unknown as PrismaClient, transaction };
}

function unknownPostgres(code: string): Prisma.PrismaClientUnknownRequestError {
  return new Prisma.PrismaClientUnknownRequestError(
    `ConnectorError(QueryError(PostgresError { code: "${code}", message: "safe" }))`,
    { clientVersion: "6.19.3" }
  );
}

describe("run preparation transaction retries", () => {
  it("retries a Prisma unknown-request PostgreSQL deadlock with bounded delay", async () => {
    const { client, transaction } = clientWithFailures(unknownPostgres("40P01"));
    const delay = vi.fn(async () => undefined);
    const operation = vi.fn(async () => "complete");

    await expect(repeatableReadTransaction(client, operation, {
      serializationRetryDelay: delay
    })).resolves.toBe("complete");
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalledWith(1);
  });

  it("does not retry an unrelated Prisma unknown request", async () => {
    const failure = unknownPostgres("23503");
    const { client, transaction } = clientWithFailures(failure);
    const delay = vi.fn(async () => undefined);

    await expect(repeatableReadTransaction(client, async () => "unexpected", {
      serializationRetryDelay: delay
    })).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });
});
