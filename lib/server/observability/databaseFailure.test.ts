import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  databaseFailureCode,
  databaseFailureKind,
  rememberDatabaseFailure,
  retainDatabaseCause
} from "./databaseFailure";

function known(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("PRIVATE_SQL_CANARY", { clientVersion: "test", code, meta });
}

const expired = known("P2028", {
  error: "Transaction already closed: A query cannot be executed on an expired transaction. " +
    "The timeout for this transaction was 5000 ms, however 5012 ms passed since the start of the transaction."
});

describe("database failure projection", () => {
  it.each([
    ["an expired query", expired, "P2028", "transaction_expired"],
    ["an expired commit", known("P2028", {
      error: "Transaction already closed: A commit cannot be executed on an expired transaction. PRIVATE_CANARY"
    }), "P2028", "transaction_expired"],
    ["an unstartable transaction", known("P2028", { error: "Unable to start a transaction in the given time." }),
      "P2028", "transaction_start_timeout"],
    ["another transaction API failure", known("P2028", { error: "Transaction not found. PRIVATE_CANARY" }), "P2028", undefined],
    ["a lock timeout", known("P2010", { code: "55P03", message: "PRIVATE_CANARY" }), "P2010", "lock_timeout"],
    ["a statement timeout", known("P2010", { code: "57014" }), "P2010", "statement_timeout"],
    ["a deadlock", known("P2010", { code: "40P01" }), "P2010", "deadlock"],
    ["a serialization conflict", known("P2034"), "P2034", "serialization_conflict"],
    ["a connector lock timeout", new Prisma.PrismaClientUnknownRequestError(
      "Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, kind: " +
      "QueryError(PostgresError { code: \"55P03\", message: \"PRIVATE_CANARY\", severity: \"ERROR\" }) })",
      { clientVersion: "test" }
    ), "unknown", "lock_timeout"],
    ["an unavailable database", new Prisma.PrismaClientInitializationError("PRIVATE_CANARY", "test", "P1001"),
      "P1001", undefined]
  ])("projects %s by code and closed kind only", (_case, error, code, kind) => {
    expect(databaseFailureCode(error)).toBe(code);
    expect(databaseFailureKind(error)).toBe(kind);
  });

  it("follows a wrapper's cause and gives a causeless wrapper what its boundary remembered", () => {
    const settlement = new Error("settlement", { cause: expired });
    const pipeline = new Error("pipeline", { cause: settlement });
    expect([databaseFailureCode(pipeline), databaseFailureKind(pipeline)]).toEqual(["P2028", "transaction_expired"]);

    const coordinator = new Error("memory_job_commit_timeout");
    expect(databaseFailureCode(coordinator)).toBe("unknown");
    retainDatabaseCause(coordinator, known("P2010", { code: "55P03" }));
    expect([databaseFailureCode(coordinator), databaseFailureKind(coordinator)]).toEqual(["P2010", "lock_timeout"]);

    const legacy = new Error("legacy boundary");
    rememberDatabaseFailure(legacy, "P1017");
    expect([databaseFailureCode(legacy), databaseFailureKind(legacy)]).toEqual(["P1017", undefined]);
  });

  it("ignores an imposter, an invalid code and a cause chain beyond its bound", () => {
    const imposter = Object.assign(new Error("PRIVATE_CANARY"), {
      code: "P2028", meta: { error: "Unable to start a transaction" }, name: "PrismaClientKnownRequestError"
    });
    expect([databaseFailureCode(imposter), databaseFailureKind(imposter)]).toEqual(["unknown", undefined]);
    expect(databaseFailureCode(known("PRIVATE_CANARY"))).toBe("unknown");
    rememberDatabaseFailure(new Error("x"), "PRIVATE_CANARY");

    let deep: unknown = expired;
    for (let depth = 0; depth < 5; depth += 1) deep = new Error("wrapper", { cause: deep });
    expect(databaseFailureCode(deep)).toBe("unknown");
    expect(databaseFailureCode(null)).toBe("unknown");
    expect(databaseFailureKind("P2028")).toBeUndefined();
  });
});
