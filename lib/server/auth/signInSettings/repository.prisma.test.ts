// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import type { AuthSignInMethodSetting, AuthSignInPolicy } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { decodeSignInSlot } from "./activeSettings";
import { createPrismaSignInSettingsRepository, SIGN_IN_POLICY_ID } from "./repository";
import { decryptSignInSecrets } from "./secrets";

const key = randomBytes(32);
const repository = createPrismaSignInSettingsRepository({ encryptionKey: () => key, prisma });
const now = new Date("2026-10-08T12:00:00.000Z");
const requireClientSecret = (secrets: Record<string, string>) => typeof secrets.clientSecret === "string";

type Fixture = {
  admin: { id: string };
  /** A session of the admin proven by `signInMethod`. */
  session(signInMethod: string): Promise<string>;
  /** A synthetic OIDC identity bound to `source`. */
  identity(source: string): Promise<void>;
  run: string;
};

/**
 * Method settings and the policy are installation singletons: each test snapshots the rows it
 * touches, starts without them and puts the snapshot back, so a disposable database keeps
 * whatever it had.
 */
async function withSettings<T>(methods: string[], run: (fixture: Fixture) => Promise<T>): Promise<T> {
  const id = randomUUID();
  const domain = `sign-in-settings-${id}.example.com`;
  const settings = await prisma.authSignInMethodSetting.findMany({ where: { method: { in: methods } } });
  const policy = await prisma.authSignInPolicy.findUnique({ where: { id: SIGN_IN_POLICY_ID } });
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: { in: methods } } });
  await prisma.authSignInPolicy.deleteMany({ where: { id: SIGN_IN_POLICY_ID } });
  const admin = await prisma.user.create({
    data: { displayName: "Sign-in Settings Admin", email: `admin@${domain}`, role: "admin", status: "active" }
  });

  try {
    return await run({
      admin,
      async identity(source) {
        const user = await prisma.user.create({
          data: { displayName: "Directory User", email: `person-${randomUUID()}@${domain}`, status: "active" }
        });
        await prisma.authIdentity.create({
          data: {
            emailVerifiedAt: now,
            normalizedEmail: user.email!,
            provider: "oidc",
            providerAccountId: `subject-${randomUUID()}`,
            source,
            userId: user.id
          }
        });
      },
      run: id,
      async session(signInMethod) {
        const session = await prisma.authSession.create({
          data: {
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            signInMethod,
            tokenHash: `sign-in-settings-${randomUUID()}`,
            userId: admin.id
          }
        });
        return session.id;
      }
    });
  } finally {
    await prisma.authSignInMethodSetting.deleteMany({ where: { method: { in: methods } } });
    await prisma.authSignInPolicy.deleteMany({ where: { id: SIGN_IN_POLICY_ID } });
    for (const row of settings) {
      await prisma.authSignInMethodSetting.create({ data: restorable(row) });
    }
    if (policy) await prisma.authSignInPolicy.create({ data: policy });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
  }
}

function restorable(row: AuthSignInMethodSetting) {
  return { ...row, activeConfig: row.activeConfig ?? undefined, draftConfig: row.draftConfig ?? undefined };
}

async function saveOidc(input: {
  actorUserId: string;
  expectedDraftVersion: number;
  issuer?: string;
  secret?: { kind: "clear"; confirm: true } | { kind: "preserve" } | { kind: "replace"; value: string };
  validateSecrets?: (secrets: Record<string, string>) => boolean;
}) {
  return repository.saveDraft({
    actorUserId: input.actorUserId,
    config: { clientId: "client", issuer: input.issuer ?? "https://idp.example.test/realms/main" },
    expectedDraftVersion: input.expectedDraftVersion,
    method: "oidc",
    now,
    secretActions: input.secret ? { clientSecret: input.secret } : {},
    validateSecrets: input.validateSecrets ?? requireClientSecret
  });
}

function inspect(source: string | null) {
  return (row: AuthSignInMethodSetting) => {
    const draft = decodeSignInSlot({
      config: row.draftConfig,
      key: () => key,
      method: "oidc",
      secretEnvelope: row.draftSecretEnvelope,
      secretGeneration: row.draftSecretGeneration
    });
    if (!draft.ok) return { problem: draft.code };
    return { problem: null, source: source === null ? null : { provider: "oidc" as const, source } };
  };
}

describe("sign-in settings repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("versions drafts and keeps secrets write-only, encrypted under the method's purpose", async () => {
    await withSettings(["oidc"], async ({ admin }) => {
      await expect(saveOidc({ actorUserId: admin.id, expectedDraftVersion: 0 })).resolves.toEqual({ code: "invalid_configuration", ok: false });

      const first = await saveOidc({ actorUserId: admin.id, expectedDraftVersion: 0, secret: { kind: "replace", value: "first-client-secret" } });
      expect(first.ok).toBe(true);
      const created = first.ok ? first.value : null;
      expect(created).toMatchObject({ draftSecretGeneration: 1, draftVersion: 1, secretGenerationCounter: 1 });
      expect(created!.draftSecretEnvelope).not.toContain("first-client-secret");
      expect(decryptSignInSecrets({ envelope: created!.draftSecretEnvelope!, generation: 1, key, method: "oidc" }))
        .toEqual({ clientSecret: "first-client-secret" });
      expect(() => decryptSignInSecrets({ envelope: created!.draftSecretEnvelope!, generation: 1, key, method: "ldap" })).toThrow();

      await expect(saveOidc({ actorUserId: admin.id, expectedDraftVersion: 0, secret: { kind: "preserve" } }))
        .resolves.toEqual({ code: "draft_conflict", ok: false });

      // A blank secret keeps the stored envelope as it is.
      const kept = await saveOidc({ actorUserId: admin.id, expectedDraftVersion: 1, issuer: "https://idp.example.test/realms/other", secret: { kind: "preserve" } });
      expect(kept.ok && kept.value).toMatchObject({
        draftConfig: expect.objectContaining({ issuer: "https://idp.example.test/realms/other" }),
        draftSecretEnvelope: created!.draftSecretEnvelope,
        draftSecretGeneration: 1,
        draftVersion: 2
      });

      const replaced = await saveOidc({ actorUserId: admin.id, expectedDraftVersion: 2, secret: { kind: "replace", value: "second-client-secret" } });
      expect(replaced.ok && replaced.value).toMatchObject({ draftSecretGeneration: 2, draftVersion: 3, secretGenerationCounter: 2 });

      // Clearing needs a contract that allows the secret to be absent.
      await expect(saveOidc({ actorUserId: admin.id, expectedDraftVersion: 3, secret: { confirm: true, kind: "clear" } }))
        .resolves.toEqual({ code: "invalid_configuration", ok: false });
      const cleared = await saveOidc({ actorUserId: admin.id, expectedDraftVersion: 3, secret: { confirm: true, kind: "clear" }, validateSecrets: () => true });
      expect(cleared.ok && cleared.value).toMatchObject({ draftSecretEnvelope: null, draftSecretGeneration: null, draftVersion: 4 });
    });
  });

  it("activates only a tested current draft and copies it atomically", async () => {
    await withSettings(["oidc"], async ({ admin }) => {
      await saveOidc({ actorUserId: admin.id, expectedDraftVersion: 0, secret: { kind: "replace", value: "client-secret" } });
      const activate = (input: { confirm?: boolean; draft: number; active: number; requiresTest?: boolean }) => repository.activate({
        actorUserId: admin.id,
        confirmSourceChange: input.confirm ?? true,
        expectedActiveVersion: input.active,
        expectedDraftVersion: input.draft,
        inspectDraft: inspect(null),
        method: "oidc",
        now,
        requiresTest: input.requiresTest ?? true
      });

      await expect(activate({ active: 0, draft: 1 })).resolves.toEqual({ code: "not_tested", ok: false });
      await repository.recordDraftTest({ at: now, code: "discovery_failed", draftVersion: 1, method: "oidc", passed: false });
      await expect(activate({ active: 0, draft: 1 })).resolves.toEqual({ code: "not_tested", ok: false });
      await expect(repository.recordDraftTest({ at: now, code: "accepted", draftVersion: 0, method: "oidc", passed: true }))
        .resolves.toEqual({ code: "draft_conflict", ok: false });
      await repository.recordDraftTest({ at: now, code: "accepted", draftVersion: 1, method: "oidc", passed: true });
      await expect(activate({ active: 1, draft: 1 })).resolves.toEqual({ code: "active_conflict", ok: false });

      const activated = await activate({ active: 0, draft: 1 });
      expect(activated.ok && activated.value).toMatchObject({
        activatedByUserId: admin.id,
        activeVersion: 1,
        enabled: true,
        healthActiveVersion: 1
      });
      const row = activated.ok ? activated.value : null;
      expect(row!.activeSecretEnvelope).toBe(row!.draftSecretEnvelope);
      expect(row!.activeConfig).toEqual(row!.draftConfig);

      // A new draft drops the test result; the active configuration stays until the next activation.
      const changed = await saveOidc({ actorUserId: admin.id, expectedDraftVersion: 1, issuer: "https://idp.example.test/realms/next", secret: { kind: "preserve" } });
      expect(changed.ok && changed.value).toMatchObject({ activeVersion: 1, draftTestCode: null, enabled: true, testedDraftVersion: null });
      await expect(activate({ active: 1, draft: 2 })).resolves.toEqual({ code: "not_tested", ok: false });
      await expect(activate({ active: 1, draft: 2, requiresTest: false })).resolves.toMatchObject({ ok: true });
    });
  });

  it("asks for confirmation when identities of another source would stop signing in", async () => {
    await withSettings(["oidc"], async ({ admin, identity, run }) => {
      const oldSource = `https://idp-${run}.example.test/realms/old`;
      const newSource = `https://idp-${run}.example.test/realms/new`;
      await identity(oldSource);
      await saveOidc({ actorUserId: admin.id, expectedDraftVersion: 0, issuer: newSource, secret: { kind: "replace", value: "client-secret" } });
      const activate = (confirmSourceChange: boolean) => repository.activate({
        actorUserId: admin.id,
        confirmSourceChange,
        expectedActiveVersion: 0,
        expectedDraftVersion: 1,
        inspectDraft: inspect(newSource),
        method: "oidc",
        now,
        requiresTest: false
      });

      const refused = await activate(false);
      expect(refused).toMatchObject({ code: "source_changed", ok: false });
      expect(!refused.ok && refused.affectedIdentities).toBeGreaterThanOrEqual(1);
      await expect(prisma.authSignInMethodSetting.findUniqueOrThrow({ where: { method: "oidc" } }))
        .resolves.toMatchObject({ activeVersion: 0, enabled: false });
      await expect(activate(true)).resolves.toMatchObject({ ok: true });
    });
  });

  it("disables without deleting and keeps health to the active version", async () => {
    await withSettings(["oidc"], async ({ admin }) => {
      await saveOidc({ actorUserId: admin.id, expectedDraftVersion: 0, secret: { kind: "replace", value: "client-secret" } });
      await repository.activate({
        actorUserId: admin.id,
        confirmSourceChange: true,
        expectedActiveVersion: 0,
        expectedDraftVersion: 1,
        inspectDraft: inspect(null),
        method: "oidc",
        now,
        requiresTest: false
      });

      await expect(repository.recordHealth({ activeVersion: 0, at: now, code: "accepted", method: "oidc" })).resolves.toBe(false);
      await expect(repository.recordHealth({ activeVersion: 1, at: now, code: "exchange_failed", method: "oidc" })).resolves.toBe(true);
      await expect(prisma.authSignInMethodSetting.findUniqueOrThrow({ where: { method: "oidc" } }))
        .resolves.toMatchObject({ lastFailureAt: now, lastFailureCode: "exchange_failed" });
      expect((await repository.loadEnabled()).map((row) => row.method)).toContain("oidc");

      const disabled = await repository.disable({ actorUserId: admin.id, expectedActiveVersion: 1, method: "oidc", now });
      expect(disabled.ok && disabled.value).toMatchObject({
        activeConfig: expect.objectContaining({ clientId: "client" }),
        activeVersion: 2,
        enabled: false,
        lastFailureCode: null
      });
      expect((await repository.loadEnabled()).map((row) => row.method)).not.toContain("oidc");
      await expect(repository.disable({ actorUserId: admin.id, expectedActiveVersion: 2, method: "oidc", now }))
        .resolves.toEqual({ code: "not_configured", ok: false });
    });
  });

  it("switches password sign-in off only from a session of an active external method", async () => {
    await withSettings(["oidc", "google"], async ({ admin, session }) => {
      const update = (input: { environment?: string[]; expectedVersion: number; passwordLoginEnabled: boolean; sessionId: string }) =>
        repository.updatePolicy({
          actorUserId: admin.id,
          environmentMethods: new Set(input.environment ?? []),
          expectedVersion: input.expectedVersion,
          now,
          passwordLoginEnabled: input.passwordLoginEnabled,
          registrationEnabled: true,
          sessionId: input.sessionId
        });

      await expect(repository.readPolicy()).resolves.toBeNull();
      await expect(update({ expectedVersion: 0, passwordLoginEnabled: false, sessionId: await session("password") }))
        .resolves.toEqual({ code: "lockout_risk", ok: false });
      await expect(update({ expectedVersion: 0, passwordLoginEnabled: false, sessionId: await session("bootstrap") }))
        .resolves.toEqual({ code: "lockout_risk", ok: false });
      // OIDC proved the session, but OIDC is not active any more.
      await expect(update({ expectedVersion: 0, passwordLoginEnabled: false, sessionId: await session("oidc") }))
        .resolves.toEqual({ code: "lockout_risk", ok: false });

      const googleSession = await session("google");
      await expect(update({ expectedVersion: 0, passwordLoginEnabled: false, sessionId: googleSession, environment: ["google"] }))
        .resolves.toMatchObject({ ok: true, value: { passwordLoginEnabled: false, version: 1 } });
      await expect(update({ expectedVersion: 0, passwordLoginEnabled: true, sessionId: googleSession }))
        .resolves.toEqual({ code: "policy_conflict", ok: false });
      // Turning passwords back on needs no external session.
      await expect(update({ expectedVersion: 1, passwordLoginEnabled: true, sessionId: await session("password") }))
        .resolves.toMatchObject({ ok: true, value: { passwordLoginEnabled: true, version: 2 } });

      await saveOidc({ actorUserId: admin.id, expectedDraftVersion: 0, secret: { kind: "replace", value: "client-secret" } });
      await repository.activate({
        actorUserId: admin.id,
        confirmSourceChange: true,
        expectedActiveVersion: 0,
        expectedDraftVersion: 1,
        inspectDraft: inspect(null),
        method: "oidc",
        now,
        requiresTest: false
      });
      await expect(update({ expectedVersion: 2, passwordLoginEnabled: false, sessionId: await session("oidc") }))
        .resolves.toMatchObject({ ok: true, value: { passwordLoginEnabled: false, version: 3 } });
      await expect(prisma.authSignInPolicy.findUniqueOrThrow({ where: { id: SIGN_IN_POLICY_ID } }))
        .resolves.toMatchObject({ passwordLoginEnabled: false, updatedByUserId: admin.id } satisfies Partial<AuthSignInPolicy>);
    });
  });
});
