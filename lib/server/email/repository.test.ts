import { Prisma, type PrismaClient, type SmtpControl } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { AdminEmailConfiguration } from "../../contracts/email";
import { createPrismaEmailRepository, SMTP_CONTROL_ID } from "./repository";

const KEY = Buffer.alloc(32, 41);
const FIRST_TIME = new Date("2026-07-23T12:00:00.000Z");

function configuration(host = "smtp.example.com"): AdminEmailConfiguration {
  return {
    allowInternalNetwork: false,
    authentication: { mode: "password", username: "mailer@example.com" },
    from: { address: "noreply@example.com", displayName: "AIQSA" },
    host,
    port: 465,
    transport: "implicit_tls"
  };
}

function emptyRow(): SmtpControl {
  return {
    activatedAt: null,
    activatedByUserId: null,
    activeConfig: null,
    activePasswordEnvelope: null,
    activeSecretGeneration: null,
    activeVersion: 0,
    configurationUpdatedAt: null,
    configurationUpdatedByUserId: null,
    createdAt: FIRST_TIME,
    draftConfig: null,
    draftPasswordEnvelope: null,
    draftSecretGeneration: null,
    draftTestAt: null,
    draftTestCode: null,
    draftTestVersion: null,
    draftVersion: 0,
    enabled: false,
    healthActiveVersion: null,
    id: SMTP_CONTROL_ID,
    lastAcceptedAt: null,
    lastAttemptAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
    secretGenerationCounter: 0,
    testedDraftVersion: null
  };
}

function createMemoryPrisma(initial = emptyRow()): {
  client: PrismaClient;
  getRow(): SmtpControl;
} {
  let row = structuredClone(initial);

  function matches(where: Record<string, unknown> | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, value]) => {
      if (key === "OR" && Array.isArray(value)) {
        return value.some((candidate) => matches(candidate as Record<string, unknown>));
      }
      const current = row[key as keyof SmtpControl];
      if (value && typeof value === "object" && "lte" in value) {
        const upper = (value as { lte: Date }).lte;
        return current instanceof Date && current <= upper;
      }
      return current === value;
    });
  }

  function apply(data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
      if (value === Prisma.DbNull) {
        (row as unknown as Record<string, unknown>)[key] = null;
      } else if (value && typeof value === "object" && "increment" in value) {
        const increment = (value as { increment: number }).increment;
        const current = (row as unknown as Record<string, number>)[key];
        (row as unknown as Record<string, number>)[key] = current + increment;
      } else {
        (row as unknown as Record<string, unknown>)[key] = structuredClone(value);
      }
    }
  }

  const smtpControl = {
    async findUnique() {
      return structuredClone(row);
    },
    async update(input: { data: Record<string, unknown>; where: Record<string, unknown> }) {
      if (!matches(input.where)) throw new Error("not found");
      apply(input.data);
      return structuredClone(row);
    },
    async updateMany(input: { data: Record<string, unknown>; where?: Record<string, unknown> }) {
      if (!matches(input.where)) return { count: 0 };
      apply(input.data);
      return { count: 1 };
    }
  };
  const transactionClient = {
    $queryRaw: async () => [{ id: SMTP_CONTROL_ID }],
    smtpControl
  };
  const client = {
    $transaction: async (callback: (tx: typeof transactionClient) => unknown) =>
      callback(transactionClient),
    smtpControl
  } as unknown as PrismaClient;
  return { client, getRow: () => structuredClone(row) };
}

describe("Prisma email repository", () => {
  it("keeps exact tested draft/password generations and monotonic versions", async () => {
    const memory = createMemoryPrisma();
    const repository = createPrismaEmailRepository({
      encryptionKey: () => KEY,
      prisma: memory.client
    });

    const saved = await repository.saveDraft({
      actorUserId: "admin-1",
      configuration: configuration(),
      expectedDraftVersion: 0,
      now: FIRST_TIME,
      passwordAction: { kind: "replace", password: "smtp-secret-one" }
    });
    expect(saved).toMatchObject({
      ok: true,
      value: { draft: { passwordConfigured: true, test: null, version: 1 } }
    });
    expect(memory.getRow()).toMatchObject({
      draftSecretGeneration: 1,
      draftVersion: 1,
      secretGenerationCounter: 1
    });
    expect(memory.getRow().draftPasswordEnvelope).not.toContain("smtp-secret-one");

    const snapshot = await repository.loadDraftForTest(1);
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        configuration: {
          authentication: { password: "smtp-secret-one", username: "mailer@example.com" }
        },
        draftVersion: 1
      }
    });
    expect(await repository.recordDraftTest({
      at: FIRST_TIME,
      code: "accepted",
      draftVersion: 1
    })).toMatchObject({ ok: true, value: { draft: { test: { tested: true } } } });

    const preserved = await repository.saveDraft({
      actorUserId: "admin-1",
      configuration: configuration("smtp2.example.com"),
      expectedDraftVersion: 1,
      now: new Date(FIRST_TIME.getTime() + 1_000),
      passwordAction: { kind: "preserve" }
    });
    expect(preserved).toMatchObject({ ok: true, value: { draft: { test: null, version: 2 } } });
    expect(memory.getRow()).toMatchObject({
      draftSecretGeneration: 1,
      secretGenerationCounter: 1,
      testedDraftVersion: null
    });
    expect(await repository.recordDraftTest({
      at: FIRST_TIME,
      code: "accepted",
      draftVersion: 1
    })).toEqual({ ok: false, code: "draft_conflict" });

    await repository.recordDraftTest({ at: FIRST_TIME, code: "accepted", draftVersion: 2 });
    const activated = await repository.activate({
      actorUserId: "admin-1",
      expectedActiveVersion: 0,
      expectedDraftVersion: 2,
      now: new Date(FIRST_TIME.getTime() + 2_000)
    });
    expect(activated).toMatchObject({
      ok: true,
      value: {
        active: { enabled: true, passwordConfigured: true, version: 1 },
        health: { activeVersion: 1, degraded: false }
      }
    });
    expect(memory.getRow().activePasswordEnvelope).toBe(memory.getRow().draftPasswordEnvelope);
    expect(memory.getRow().activeSecretGeneration).toBe(1);

    await repository.saveDraft({
      actorUserId: "admin-1",
      configuration: configuration("smtp3.example.com"),
      expectedDraftVersion: 2,
      now: FIRST_TIME,
      passwordAction: { kind: "replace", password: "smtp-secret-two" }
    });
    expect(memory.getRow()).toMatchObject({
      activeSecretGeneration: 1,
      draftSecretGeneration: 2,
      draftVersion: 3,
      secretGenerationCounter: 2
    });
    expect(await repository.activate({
      actorUserId: "admin-1",
      expectedActiveVersion: 1,
      expectedDraftVersion: 3,
      now: FIRST_TIME
    })).toEqual({ ok: false, code: "not_tested" });
    expect(memory.getRow()).toMatchObject({ activeVersion: 1, enabled: true });
  });

  it("disables, re-enables, health-fences, and clears without resetting lineage", async () => {
    const row = emptyRow();
    const noAuth = {
      ...configuration(),
      authentication: { mode: "none" as const }
    };
    row.draftConfig = noAuth;
    row.draftVersion = 7;
    row.activeConfig = noAuth;
    row.activeVersion = 5;
    row.activatedAt = FIRST_TIME;
    row.enabled = true;
    const memory = createMemoryPrisma(row);
    const repository = createPrismaEmailRepository({ encryptionKey: () => KEY, prisma: memory.client });

    const disabled = await repository.disable({
      actorUserId: "admin-1",
      expectedActiveVersion: 5,
      now: FIRST_TIME
    });
    expect(disabled).toMatchObject({ ok: true, value: { active: { enabled: false, version: 6 } } });
    expect(await repository.loadActiveForSend()).toEqual({
      ok: true,
      value: { kind: "unavailable" }
    });

    const enabled = await repository.enable({
      actorUserId: "admin-1",
      expectedActiveVersion: 6,
      now: FIRST_TIME
    });
    expect(enabled).toMatchObject({ ok: true, value: { active: { enabled: true, version: 7 } } });
    expect(await repository.recordDeliveryOutcome({
      activeVersion: 6,
      at: FIRST_TIME,
      code: "smtp_connection_failed"
    })).toBe(false);
    expect(await repository.recordDeliveryOutcome({
      activeVersion: 7,
      at: FIRST_TIME,
      code: "smtp_connection_failed"
    })).toBe(true);
    expect(await repository.recordDeliveryOutcome({
      activeVersion: 7,
      at: new Date(FIRST_TIME.getTime() - 1_000),
      code: "accepted"
    })).toBe(false);
    expect((await repository.readAdminState())).toMatchObject({
      ok: true,
      value: { health: { degraded: true, lastFailureCode: "smtp_connection_failed" } }
    });

    const cleared = await repository.clear({
      actorUserId: "admin-1",
      expectedActiveVersion: 7,
      expectedDraftVersion: 7,
      now: FIRST_TIME
    });
    expect(cleared).toMatchObject({
      ok: true,
      value: {
        active: { configuration: null, enabled: false, version: 8 },
        draft: { configuration: null, version: 8 },
        health: { activeVersion: null, degraded: false }
      }
    });
    expect(memory.getRow()).toMatchObject({
      activeVersion: 8,
      draftVersion: 8,
      id: SMTP_CONTROL_ID,
      secretGenerationCounter: 0
    });
  });

  it("requires an explicit clear for no-auth and never exposes secret material", async () => {
    const memory = createMemoryPrisma();
    const repository = createPrismaEmailRepository({ encryptionKey: () => KEY, prisma: memory.client });
    const noAuth: AdminEmailConfiguration = {
      allowInternalNetwork: true,
      authentication: { mode: "none" },
      from: { address: "noreply@example.com", displayName: null },
      host: "10.0.0.8",
      port: 25,
      transport: "plaintext_internal_no_auth"
    };

    expect(await repository.saveDraft({
      actorUserId: "admin-1",
      configuration: noAuth,
      expectedDraftVersion: 0,
      now: FIRST_TIME,
      passwordAction: { kind: "preserve" }
    })).toEqual({ ok: false, code: "invalid_configuration" });
    const saved = await repository.saveDraft({
      actorUserId: "admin-1",
      configuration: noAuth,
      expectedDraftVersion: 0,
      now: FIRST_TIME,
      passwordAction: { confirm: true, kind: "clear" }
    });
    expect(saved).toMatchObject({
      ok: true,
      value: { draft: { configuration: noAuth, passwordConfigured: false } }
    });
    expect(JSON.stringify(saved)).not.toContain("Envelope");
  });
});
