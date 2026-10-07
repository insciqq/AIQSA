// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { encryptProviderCredentialSecret } from "../providers/credentialSecrets";
import { prisma } from "../prisma";
import { createSpeechToTextAdminService } from "./adminService";
import { catalogDictation, resolveSpeechToTextRole, SPEECH_TO_TEXT_POLICY_ID } from "./role";
import { transcriptionUsageEvent } from "./usage";

afterAll(() => prisma.$disconnect());

const KEY = randomBytes(32);
const NOW = new Date("2026-10-08T12:00:00.000Z");

describe("Prisma Speech to text role", () => {
  it("persists a passing Test on the policy row, accounts it and records a personal dictation row", async () => {
    const marker = `speech-to-text-${randomUUID()}`;
    const connectionId = `${marker}-conn`, credentialId = randomUUID(), versionId = randomUUID();
    const config = { allowPrivateNetwork: false, apiRoot: "https://stt.example.test/v1", authenticationMode: "bearer", responseTimeoutMs: 5_000 };
    const prior = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: SPEECH_TO_TEXT_POLICY_ID }, select: {
      speechToTextConfiguredAt: true, speechToTextConnectionId: true, speechToTextCredentialVersionId: true, speechToTextModelId: true,
      updatedByUserId: true } });
    const admin = await prisma.user.create({ data: { displayName: "STT admin", email: `admin@${marker}.example.com`, role: "admin", status: "active" } });
    try {
      await prisma.providerConnection.create({ data: { id: connectionId, displayName: "STT fixture", family: "openai_compatible",
        activeConfig: config, draftConfig: config, activeVersion: 1, draftVersion: 1, activatedAt: NOW, enabled: true } });
      await prisma.providerCredential.create({ data: { id: credentialId, connectionId, label: "Fixture", enabled: true } });
      await prisma.providerCredentialVersion.create({ data: { id: versionId, credentialId, version: 1, activatedAt: NOW, testedAt: NOW,
        testEvidence: { authenticationMode: "bearer" },
        secretEnvelope: encryptProviderCredentialSecret({ credentialId, key: KEY, secret: "stt-fixture-key", valueId: versionId }) } });
      await prisma.providerCredential.update({ where: { id: credentialId }, data: { activeVersionId: versionId, activatedAt: NOW } });
      await prisma.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: credentialId } });

      const fetchFn: typeof fetch = async () => Response.json({ text: "ah", usage: { seconds: 1.2, cost: 0.0001 } });
      const service = createSpeechToTextAdminService({ db: prisma, encryptionKey: () => KEY, fetchFn, now: () => NOW });
      const before = await service.read();
      expect(before.connections).toContainEqual({ displayName: "STT fixture", family: "openai_compatible", id: connectionId, ready: true });
      await service.testAndSave({ connectionId, expectedConfiguredAt: before.configuredAt, modelId: "whisper-1", userId: admin.id });

      expect(await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: SPEECH_TO_TEXT_POLICY_ID } })).toMatchObject({
        speechToTextConfiguredAt: NOW, speechToTextConnectionId: connectionId, speechToTextCredentialVersionId: versionId,
        speechToTextModelId: "whisper-1", updatedByUserId: admin.id });
      const role = await resolveSpeechToTextRole(prisma, { encryptionKey: () => KEY });
      expect(catalogDictation(role)).toEqual({ available: true, unavailableReason: null });
      if (!role.ok) throw new Error("expected a usable role");
      await expect(role.binding.secret!()).resolves.toBe("stt-fixture-key");
      expect(await prisma.usageEvent.findMany({ where: { userId: admin.id }, select: { estimatedCostMicros: true, modelId: true, provider: true, purpose: true } }))
        .toEqual([{ estimatedCostMicros: 100, modelId: "whisper-1", provider: "openai_compatible", purpose: "model_check" }]);

      await prisma.usageEvent.create({ data: transcriptionUsageEvent({ family: "openai_compatible", modelId: "whisper-1",
        purpose: "speech_to_text", usage: { costUsd: null, inputTokens: null, outputTokens: null, seconds: 6, totalTokens: null }, userId: admin.id }) });
      expect(await prisma.usageEvent.count({ where: { userId: admin.id, purpose: "speech_to_text", estimatedCostMicros: null } })).toBe(1);

      // A stale fence never overwrites the saved role.
      await expect(service.clear({ expectedConfiguredAt: null, userId: admin.id })).rejects.toMatchObject({ code: "speech_to_text_stale" });
      await service.clear({ expectedConfiguredAt: NOW.toISOString(), userId: admin.id });
      expect(catalogDictation(await resolveSpeechToTextRole(prisma, { encryptionKey: () => KEY })))
        .toEqual({ available: false, unavailableReason: "not_configured" });
    } finally {
      await prisma.systemModelPolicy.update({ where: { id: SPEECH_TO_TEXT_POLICY_ID }, data: prior });
      await prisma.usageEvent.deleteMany({ where: { userId: admin.id } });
      await prisma.providerConnection.updateMany({ where: { id: connectionId }, data: { defaultCredentialId: null } });
      await prisma.providerCredential.updateMany({ where: { connectionId }, data: { activeVersionId: null } });
      await prisma.providerCredentialVersion.deleteMany({ where: { credentialId } });
      await prisma.providerCredential.deleteMany({ where: { connectionId } });
      await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
      await prisma.user.deleteMany({ where: { id: admin.id } });
    }
  });
});
