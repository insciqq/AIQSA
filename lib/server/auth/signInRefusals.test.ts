// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import {
  noteSignInRefusal,
  recordSignInRefusal,
  settlementRefusalCode,
  trustedRefusalSubject,
  type SignInRefusalDatabase,
  type SignInRefusalInput
} from "./signInRefusals";

const NOW = new Date("2026-10-16T06:31:00.000Z");

type Statement = Readonly<{ kind: "execute" | "query"; values: unknown[] }>;

/** A database whose subject upsert reports `recorded` rows; every statement's parameters are kept. */
function fakeDatabase(recorded: number) {
  const statements: Statement[] = [];
  const db = {
    $executeRaw: vi.fn(async (sql: { values: unknown[] }) => {
      statements.push({ kind: "execute", values: sql.values });
      return 1;
    }),
    $queryRaw: vi.fn(async (sql: { values: unknown[] }) => {
      statements.push({ kind: "query", values: sql.values });
      return [{ recorded: BigInt(recorded) }];
    })
  };
  return { db: db as unknown as SignInRefusalDatabase, statements };
}

function refusal(input: Partial<SignInRefusalInput> = {}): SignInRefusalInput {
  return { code: "not_allowed", method: "yandex", now: NOW, subject: { email: "ana@example.com" }, ...input };
}

describe("refused sign-in subjects", () => {
  it("names an external refusal's email only when the source verified it or the method trusts it", () => {
    expect(trustedRefusalSubject({ email: " Ana@Example.COM ", emailVerified: true, trustUnverifiedEmail: false }))
      .toEqual({ email: "ana@example.com" });
    expect(trustedRefusalSubject({ email: "ana@example.com", emailVerified: false, trustUnverifiedEmail: true }))
      .toEqual({ email: "ana@example.com" });
    expect(trustedRefusalSubject({ email: "ana@example.com", emailVerified: false, trustUnverifiedEmail: false })).toBeNull();
    expect(trustedRefusalSubject({ email: null, emailVerified: true, trustUnverifiedEmail: true })).toBeNull();
    expect(trustedRefusalSubject({ email: "not an address", emailVerified: true, trustUnverifiedEmail: false })).toBeNull();
  });

  it("journals a pending account under the sign-in code it answers with", () => {
    expect(settlementRefusalCode("pending")).toBe("account_pending");
    expect(settlementRefusalCode("not_allowed")).toBe("not_allowed");
    expect(settlementRefusalCode("source_changed")).toBe("source_changed");
  });
});

describe("recording a refused sign-in", () => {
  it("counts the attempt on its subject's row for its UTC day", async () => {
    const { db, statements } = fakeDatabase(1);

    await recordSignInRefusal(db, refusal());

    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ kind: "query" });
    expect(statements[0]!.values).toEqual(expect.arrayContaining([
      "2026-10-16", "yandex", "not_allowed", "email:ana@example.com", "ana@example.com", null
    ]));
  });

  it("keys an account by its id and a refusal without a verified email by nobody", async () => {
    const account = fakeDatabase(1);
    await recordSignInRefusal(account.db, refusal({ code: "invalid_credentials", method: "password", subject: { userId: "user-1" } }));
    expect(account.statements[0]!.values).toEqual(expect.arrayContaining(["user:user-1", "user-1"]));

    const nobody = fakeDatabase(1);
    await recordSignInRefusal(nobody.db, refusal({ method: "saml", subject: null }));
    expect(nobody.statements[0]!.values).toEqual(expect.arrayContaining(["no_verified_email"]));
    expect(nobody.statements[0]!.values).not.toContain("ana@example.com");
  });

  it("counts a new subject on its method and code's overflow row once the day is full", async () => {
    const { db, statements } = fakeDatabase(0);

    await recordSignInRefusal(db, refusal());

    expect(statements.map((statement) => statement.kind)).toEqual(["query", "execute"]);
    expect(statements[1]!.values).toEqual(expect.arrayContaining(["2026-10-16", "yandex", "not_allowed"]));
    expect(statements[1]!.values).not.toContain("ana@example.com");
  });

  it("refuses a subject that is not normalized or a code outside the journal, writing nothing and naming nobody", async () => {
    const observed = await captureRunObservation();
    const { db, statements } = fakeDatabase(1);

    await recordSignInRefusal(db, refusal({ subject: { email: "Ana@Example.com" } }));
    await recordSignInRefusal(db, refusal({ subject: { userId: "" } }));
    await recordSignInRefusal(db, refusal({ code: "rate_limited" as SignInRefusalInput["code"] }));
    await recordSignInRefusal(db, refusal({ now: new Date(Number.NaN) }));

    expect(statements).toEqual([]);
    const failures = observed.records().filter((record) => record.code === "sign_in_refusal_record_failed");
    expect(failures).toHaveLength(4);
    expect(JSON.stringify(observed.records())).not.toMatch(/ana@example\.com/iu);
  });

  it("drops a write the database refuses and reports it without the email", async () => {
    const observed = await captureRunObservation();
    const db = {
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn(async () => {
        throw new Error("insert or update on table violates foreign key constraint for ana@example.com");
      })
    } as unknown as SignInRefusalDatabase;

    await expect(recordSignInRefusal(db, refusal())).resolves.toBeUndefined();

    expect(observed.records()).toEqual([expect.objectContaining({
      action: "skip", code: "sign_in_refusal_record_failed", event: "service_operation", outcome: "failed",
      stage: "write", subsystem: "database"
    })]);
    expect(JSON.stringify(observed.records())).not.toMatch(/ana@example\.com|foreign key/iu);
  });

  it("starts a background record that never reaches the caller, whatever the recorder does", async () => {
    expect(() => noteSignInRefusal(undefined, refusal())).not.toThrow();
    expect(() => noteSignInRefusal(() => { throw new Error("journal unavailable"); }, refusal())).not.toThrow();
    const rejecting = vi.fn(async () => { throw new Error("journal unavailable"); });
    noteSignInRefusal(rejecting, refusal());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejecting).toHaveBeenCalledOnce();
  });
});
