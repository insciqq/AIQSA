import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import type { McpDraftValidator, McpDraftValidationInput } from "./draftValidator";
import {
  decryptMcpEnvelope,
  mcpPersonalConfigEnvelopeContext,
  mcpSharedConfigEnvelopeContext
} from "./encryption";
import { createPrismaMcpRepository } from "./prismaRepository";
import { createPrismaMcpRuntimeRepository } from "./runtimeRepository";

const enabled = process.env.AIQSA_MCP_INTEGRATION_TEST === "1";
const integration = enabled ? describe : describe.skip;
const database = new PrismaClient();
const configuredKey = process.env.AIQSA_ENCRYPTION_KEY
  ? Buffer.from(process.env.AIQSA_ENCRYPTION_KEY, "base64")
  : null;
const key = configuredKey?.length === 32 ? configuredKey : Buffer.alloc(32, 0x35);
const suffix = randomUUID();

const draft: McpDraftConfiguration = {
  auth: { mode: "none" },
  runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 45_000 },
  slots: [
    {
      label: "API key",
      policy: { allowPersonalOverride: true, kind: "shared" },
      sensitive: true,
      slotKey: "api-key",
      target: { kind: "environment", name: "API_KEY" },
      valueType: "secret"
    },
    {
      label: "Workspace key",
      policy: { kind: "personal", required: true },
      sensitive: true,
      slotKey: "workspace-key",
      target: { kind: "environment", name: "WORKSPACE_KEY" },
      valueType: "secret"
    },
    {
      enumValues: ["private", "team"],
      label: "Visibility",
      maxLength: 16,
      minLength: 4,
      policy: { allowPersonalOverride: true, kind: "shared" },
      sensitive: false,
      slotKey: "visibility",
      target: { kind: "environment", name: "VISIBILITY" },
      valueType: "enum"
    }
  ],
  source: { args: [], kind: "npm", packageName: "example-mcp", versionSelector: "1.0.0" },
  transport: "stdio"
};

integration("Prisma MCP repository", () => {
  let materialization = 0;
  const validationInputs: McpDraftValidationInput[] = [];
  const draftValidator: McpDraftValidator = {
    async validate(input) {
      validationInputs.push(input);
      materialization += 1;
      const sourceVersion = input.draft.source.kind === "npm"
        ? input.draft.source.versionSelector ?? "latest"
        : input.draft.source.kind;
      return {
        evidence: { protocolVersion: "2025-06-18", sourceVersion },
        kind: "ok",
        resolvedArtifact: {
          exactVersion: sourceVersion,
          imageRef: `toolhivelocal/example-mcp:materialization-${materialization}`,
          imageReferenceKind: "toolhive_generated_tag",
          kind: "toolhive_local",
          materializer: "npx",
          materialization,
          packageName: "example-mcp",
          registryArtifactUrl: `https://registry.example.test/example-mcp-${materialization}.tgz`,
          registryIntegrity: "sha512-YWJjZA==",
          sourceKind: "npm",
          sourceVersion,
          toolhiveVersion: "v0.40.1"
        },
        toolInventory: [{ description: "Create a task", name: "create_task" }]
      };
    }
  };
  const repository = createPrismaMcpRepository({ draftValidator, encryptionKey: () => key, prisma: database });
  let groupId = "";
  let adminId = "";
  let secondAdminId = "";
  let serverId = "";
  const serverIds = new Set<string>();
  let userId = "";

  beforeAll(async () => {
    const [user, group, admin, secondAdmin] = await database.$transaction([
      database.user.create({
        data: { displayName: "MCP integration user", email: `mcp-${suffix}@example.test`, status: "active" }
      }),
      database.group.create({ data: { name: `MCP integration group ${suffix}` } }),
      database.user.create({
        data: {
          displayName: "MCP activation admin",
          email: `mcp-admin-${suffix}@example.test`,
          role: "admin",
          status: "active"
        }
      }),
      database.user.create({
        data: {
          displayName: "MCP second activation admin",
          email: `mcp-admin-2-${suffix}@example.test`,
          role: "admin",
          status: "active"
        }
      })
    ]);
    userId = user.id;
    groupId = group.id;
    adminId = admin.id;
    secondAdminId = secondAdmin.id;
    await database.userGroup.create({ data: { groupId, userId } });
  });

  afterAll(async () => {
    if (serverIds.size) {
      const ids = [...serverIds];
      await database.mcpServer.updateMany({ data: { activeRevisionId: null }, where: { id: { in: ids } } });
      await database.mcpRuntimeGeneration.deleteMany({ where: { revision: { serverId: { in: ids } } } });
      await database.mcpRevision.deleteMany({ where: { serverId: { in: ids } } });
      await database.mcpServer.deleteMany({ where: { id: { in: ids } } });
    }
    if (userId) await database.user.deleteMany({ where: { id: userId } });
    if (adminId || secondAdminId) {
      await database.user.deleteMany({ where: { id: { in: [adminId, secondAdminId].filter(Boolean) } } });
    }
    if (groupId) await database.group.deleteMany({ where: { id: groupId } });
    await database.$disconnect();
  });

  it("stores encrypted values, unions grants, redacts secrets, and disables after final grant loss", async () => {
    const created = await repository.createServer({
      description: "Integration server",
      draft,
      name: "Integration MCP",
      sharedValues: { "api-key": "shared-secret", visibility: "team" }
    });
    expect(created.kind).toBe("ok");
    if (created.kind !== "ok") return;
    serverId = created.value.id;
    serverIds.add(serverId);
    expect(JSON.stringify(created.value)).not.toContain("shared-secret");
    expect(created.value.sharedValues["api-key"]?.configured).toBe(true);

    const fullAccessGroup = await database.group.findUniqueOrThrow({
      where: { systemRole: "full_access" }
    });
    await expect(database.mcpGrant.findUniqueOrThrow({
      where: { serverId_groupId: { groupId: fullAccessGroup.id, serverId } }
    })).resolves.toMatchObject({
      canUse: true,
      personalSlotKeys: []
    });
    await expect(repository.setGrant({
      canUse: false,
      groupId: fullAccessGroup.id,
      personalSlotKeys: [],
      serverId,
      userId: null
    })).resolves.toEqual({
      issues: [{ code: "system_group_grant_immutable", path: "groupId" }],
      kind: "invalid_grant"
    });
    await expect(database.mcpGrant.findUniqueOrThrow({
      where: { serverId_groupId: { groupId: fullAccessGroup.id, serverId } }
    })).resolves.toMatchObject({
      canUse: true,
      personalSlotKeys: []
    });

    await expect(database.mcpGrant.create({
      data: { canUse: true, groupId, serverId, userId }
    })).rejects.toThrow(/McpGrant_subject_check/u);
    await expect(database.mcpGrant.create({
      data: { canUse: true, groupId, personalSlotKeys: ["api-key"], serverId }
    })).rejects.toThrow(/McpGrant_group_personal_slots_check/u);

    const oneTimeSecret = "one-time-validator-secret";
    await expect(repository.testDraft({ oneTimeValues: {}, serverId })).resolves.toEqual({
      issues: [{ code: "slot_value_required", path: "oneTimeValues.workspace-key" }],
      kind: "invalid_values"
    });
    expect(validationInputs).toEqual([]);
    const tested = await repository.testDraft({
      oneTimeValues: { "workspace-key": oneTimeSecret },
      serverId
    });
    expect(tested).toMatchObject({
      kind: "ok",
      value: {
        draftTest: {
          evidence: { protocolVersion: "2025-06-18" },
          resolvedArtifact: {
            exactVersion: "1.0.0",
            imageRef: "toolhivelocal/example-mcp:materialization-1",
            materialization: 1
          },
          toolInventory: [{ name: "create_task" }]
        },
        draftTested: true
      }
    });
    expect(validationInputs[0]?.values).toMatchObject({
      "api-key": "shared-secret",
      "workspace-key": oneTimeSecret,
      visibility: "team"
    });
    expect(JSON.stringify(tested)).not.toContain(oneTimeSecret);
    const testedServer = await database.mcpServer.findUniqueOrThrow({
      select: {
        draftTestEvidence: true,
        id: true,
        sharedConfigEnvelope: true,
        sharedConfigVersion: true,
        testedDraftHash: true
      },
      where: { id: serverId }
    });
    expect(JSON.stringify(testedServer.draftTestEvidence)).not.toContain(oneTimeSecret);
    expect(decryptMcpEnvelope<{ values: Record<string, string> }>(
      testedServer.sharedConfigEnvelope!,
      key,
      mcpSharedConfigEnvelopeContext(testedServer.id, testedServer.sharedConfigVersion)
    )
      .values["api-key"]).toBe("shared-secret");

    const leakingSecret = "validator-must-not-persist-this";
    const leakingRepository = createPrismaMcpRepository({
      draftValidator: {
        async validate(input) {
          return {
            evidence: { accidentalValue: input.values["workspace-key"] ?? null },
            kind: "ok",
            resolvedArtifact: null,
            toolInventory: []
          };
        }
      },
      encryptionKey: () => key,
      prisma: database
    });
    await expect(leakingRepository.testDraft({
      oneTimeValues: { "workspace-key": leakingSecret },
      serverId
    })).resolves.toEqual({
      issues: [{ code: "unsafe_validation_evidence", path: "validator" }],
      kind: "draft_validation_failed"
    });
    const evidenceAfterRejectedLeak = await database.mcpServer.findUniqueOrThrow({
      select: { draftTestEvidence: true },
      where: { id: serverId }
    });
    expect(evidenceAfterRejectedLeak.draftTestEvidence).toEqual(testedServer.draftTestEvidence);
    expect(JSON.stringify(evidenceAfterRejectedLeak)).not.toContain(leakingSecret);

    const activatedV1 = await repository.activateDraft(serverId);
    expect(activatedV1).toMatchObject({
      kind: "ok",
      value: {
        activePersonalSlots: [
          { label: "API key", slotKey: "api-key" },
          { label: "Workspace key", slotKey: "workspace-key" },
          { label: "Visibility", slotKey: "visibility" }
        ],
        activeRevision: {
          artifactStatus: "unknown",
          draftHash: testedServer.testedDraftHash,
          revisionNumber: 1,
          validationEvidence: {
            evidence: { protocolVersion: "2025-06-18" },
            toolInventory: [{ name: "create_task" }]
          }
        },
        enabled: true
      }
    });
    if (activatedV1.kind !== "ok" || !activatedV1.value.activeRevision) return;
    const revisionV1 = activatedV1.value.activeRevision;
    await expect(repository.activateDraft(serverId)).resolves.toMatchObject({
      kind: "ok",
      value: { activeRevision: { id: revisionV1.id }, revisions: [{ revisionNumber: 1 }] }
    });

    const changedSlotMeaning: McpDraftConfiguration = {
      ...draft,
      slots: draft.slots.map((slot) => slot.slotKey === "api-key"
        ? { ...slot, target: { kind: "environment", name: "DIFFERENT_API_KEY" } }
        : slot)
    };
    await repository.updateServer({ draft: changedSlotMeaning, serverId });
    await expect(repository.testDraft({
      oneTimeValues: { "workspace-key": oneTimeSecret },
      serverId
    })).resolves.toEqual({
      issues: [{ code: "slot_key_semantics_changed", path: "slots.0.slotKey" }],
      kind: "draft_validation_failed"
    });

    const draftV2: McpDraftConfiguration = {
      ...draft,
      source: { args: [], kind: "npm", packageName: "example-mcp", versionSelector: "2.0.0" }
    };
    const edited = await repository.updateServer({ draft: draftV2, serverId });
    expect(edited).toMatchObject({ kind: "ok", value: { draftTest: null, draftTested: false } });
    await expect(repository.activateDraft(serverId)).resolves.toEqual({ kind: "revision_required" });
    expect((await repository.testDraft({ oneTimeValues: { "workspace-key": oneTimeSecret }, serverId })).kind)
      .toBe("ok");
    const activatedV2 = await repository.activateDraft(serverId);
    expect(activatedV2).toMatchObject({
      kind: "ok",
      value: { activeRevision: { revisionNumber: 2 }, revisions: [{ revisionNumber: 2 }, { revisionNumber: 1 }] }
    });
    if (activatedV2.kind !== "ok" || !activatedV2.value.activeRevision) return;
    const firstV2Artifact = activatedV2.value.activeRevision.resolvedArtifact;

    expect((await repository.testDraft({
      oneTimeValues: { "workspace-key": oneTimeSecret },
      serverId
    })).kind).toBe("ok");
    const updatedSameDraft = await repository.activateDraft(serverId);
    expect(updatedSameDraft).toMatchObject({
      kind: "ok",
      value: {
        activeRevision: { revisionNumber: 3 },
        revisions: [{ revisionNumber: 3 }, { revisionNumber: 2 }, { revisionNumber: 1 }]
      }
    });
    if (updatedSameDraft.kind !== "ok" || !updatedSameDraft.value.activeRevision) return;
    expect(updatedSameDraft.value.activeRevision.draftHash).toBe(activatedV2.value.activeRevision.draftHash);
    expect(updatedSameDraft.value.activeRevision.resolvedArtifact).not.toEqual(firstV2Artifact);

    const other = await repository.createServer({
      description: "Other integration server",
      draft,
      name: "Other integration MCP",
      sharedValues: { "api-key": "other-shared-secret", visibility: "private" }
    });
    expect(other.kind).toBe("ok");
    if (other.kind !== "ok") return;
    serverIds.add(other.value.id);
    expect((await repository.testDraft({
      oneTimeValues: { "workspace-key": "other-one-time-secret" },
      serverId: other.value.id
    })).kind).toBe("ok");
    const otherActivated = await repository.activateDraft(other.value.id);
    expect(otherActivated.kind).toBe("ok");
    if (otherActivated.kind !== "ok" || !otherActivated.value.activeRevision) return;
    await expect(repository.rollbackServer({
      revisionId: otherActivated.value.activeRevision.id,
      serverId
    })).resolves.toEqual({ kind: "not_found" });
    const rolledBack = await repository.rollbackServer({ revisionId: revisionV1.id, serverId });
    expect(rolledBack).toMatchObject({
      kind: "ok",
      value: { activeRevision: { id: revisionV1.id, revisionNumber: 1 } }
    });

    const immutableV1 = await database.mcpRevision.findUniqueOrThrow({ where: { id: revisionV1.id } });
    expect(immutableV1.configuration).toMatchObject({
      source: { kind: "npm", versionSelector: "1.0.0" }
    });

    await expect(repository.rebuildRevision({
      oneTimeValues: { "workspace-key": oneTimeSecret },
      replaceDraft: false,
      revisionId: revisionV1.id,
      serverId
    })).resolves.toEqual({ kind: "draft_changed" });
    const rebuilt = await repository.rebuildRevision({
      oneTimeValues: { "workspace-key": oneTimeSecret },
      replaceDraft: true,
      revisionId: revisionV1.id,
      serverId
    });
    expect(rebuilt).toMatchObject({
      kind: "ok",
      value: {
        activeRevision: {
          revisionNumber: 4,
          resolvedArtifact: { sourceVersion: "1.0.0" }
        },
        draft: { source: { versionSelector: "1.0.0" } }
      }
    });

    expect((await repository.setGrant({
      canUse: true,
      groupId,
      personalSlotKeys: [],
      serverId,
      userId: null
    })).kind).toBe("ok");
    expect((await repository.setGrant({
      canUse: false,
      groupId: null,
      personalSlotKeys: ["api-key", "visibility", "workspace-key"],
      serverId,
      userId
    })).kind).toBe("ok");

    const catalog = await repository.listUserServers(userId);
    expect(catalog).toMatchObject([{
      enabled: false,
      fields: [
        { configured: true, slotKey: "api-key", source: "shared" },
        { configured: false, slotKey: "workspace-key", source: "missing" },
        {
          configured: true,
          enumValues: ["private", "team"],
          maxLength: 16,
          minLength: 4,
          slotKey: "visibility",
          source: "shared"
        }
      ],
      id: serverId,
      knownToolCount: 1,
      readiness: "disabled"
    }]);

    const updated = await repository.updateUserServer({
      enabled: true,
      serverId,
      userId,
      values: {
        "api-key": "personal-secret",
        "workspace-key": "personal-workspace-secret",
        visibility: "private"
      }
    });
    expect(updated).toMatchObject({
      kind: "ok",
      value: {
        enabled: true,
        fields: [
          { configured: true, slotKey: "api-key", source: "personal" },
          { configured: true, slotKey: "workspace-key", source: "personal" },
          {
            configured: true,
            enumValues: ["private", "team"],
            maxLength: 16,
            minLength: 4,
            slotKey: "visibility",
            source: "personal",
            value: "private"
          }
        ],
        readiness: "queued"
      }
    });
    expect(JSON.stringify(updated)).not.toContain("personal-secret");

    const stored = await database.mcpUserServer.findUniqueOrThrow({
      select: { id: true, personalConfigEnvelope: true, personalConfigVersion: true },
      where: { userId_serverId: { serverId, userId } }
    });
    expect(stored.personalConfigEnvelope).not.toContain("personal-secret");
    expect(decryptMcpEnvelope<{ values: Record<string, string> }>(
      stored.personalConfigEnvelope!,
      key,
      mcpPersonalConfigEnvelopeContext(stored.id, stored.personalConfigVersion)
    )
      .values["api-key"]).toBe("personal-secret");

    const sharedBeforeClear = await database.mcpServer.findUniqueOrThrow({
      select: { sharedConfigVersion: true },
      where: { id: serverId }
    });
    expect((await repository.updateServer({
      serverId,
      sharedValues: { "api-key": null }
    })).kind).toBe("ok");
    await expect(database.mcpServer.findUniqueOrThrow({
      select: { sharedConfigVersion: true },
      where: { id: serverId }
    })).resolves.toMatchObject({
      sharedConfigVersion: sharedBeforeClear.sharedConfigVersion + 1
    });

    expect((await repository.updateUserServer({
      serverId,
      userId,
      values: { "api-key": null }
    })).kind).toBe("ok");
    await expect(database.mcpUserServer.findUniqueOrThrow({
      select: { personalConfigVersion: true },
      where: { id: stored.id }
    })).resolves.toMatchObject({
      personalConfigVersion: stored.personalConfigVersion + 1
    });

    const missingGeneration = await database.mcpRuntimeGeneration.create({
      data: {
        errorCode: "mcp_artifact_missing",
        fingerprint: `missing-${suffix}`,
        revisionId: revisionV1.id,
        state: "failed",
        userServerId: stored.id
      },
      select: { id: true }
    });
    try {
      const withMissingArtifact = await repository.listAdminServers();
      expect(withMissingArtifact.find((server) => server.id === serverId)?.revisions
        .find((revision) => revision.id === revisionV1.id)?.artifactStatus).toBe("missing");
      await expect(repository.rollbackServer({ revisionId: revisionV1.id, serverId }))
        .resolves.toEqual({ kind: "artifact_missing" });
    } finally {
      await database.mcpRuntimeGeneration.deleteMany({ where: { id: missingGeneration.id } });
    }

    await repository.setGrant({
      canUse: false,
      groupId,
      personalSlotKeys: [],
      serverId,
      userId: null
    });
    await expect(database.mcpUserServer.findUniqueOrThrow({
      where: { userId_serverId: { serverId, userId } }
    })).resolves.toMatchObject({ enabled: false });
    await expect(repository.listUserServers(userId)).resolves.toEqual([]);
  });

  it("versions exact disabled-tool policy while retaining full inventory evidence", async () => {
    const policyDraft: McpDraftConfiguration = {
      ...draft,
      slots: draft.slots.filter((slot) => slot.slotKey !== "workspace-key")
    };
    const created = await repository.createServer({
      description: "Tool policy integration server",
      draft: policyDraft,
      name: "Tool policy MCP",
      sharedValues: { "api-key": "policy-shared-secret", visibility: "team" }
    });
    expect(created.kind).toBe("ok");
    if (created.kind !== "ok") return;
    const policyServerId = created.value.id;
    serverIds.add(policyServerId);

    expect((await repository.testDraft({ oneTimeValues: {}, serverId: policyServerId })).kind)
      .toBe("ok");
    const activatedV1 = await repository.activateDraft(policyServerId);
    expect(activatedV1).toMatchObject({
      kind: "ok",
      value: {
        activeRevision: {
          revisionNumber: 1,
          validationEvidence: { toolInventory: [{ name: "create_task" }] }
        }
      }
    });
    if (activatedV1.kind !== "ok" || !activatedV1.value.activeRevision) return;

    const candidateDraft: McpDraftConfiguration = {
      ...policyDraft,
      disabledToolNames: ["create_task", "temporarily_missing"]
    };
    const edited = await repository.updateServer({ draft: candidateDraft, serverId: policyServerId });
    expect(edited).toMatchObject({
      kind: "ok",
      value: {
        activeRevision: { id: activatedV1.value.activeRevision.id },
        draft: { disabledToolNames: ["create_task", "temporarily_missing"] },
        draftTest: { toolInventory: [{ name: "create_task" }] },
        draftTested: false
      }
    });
    await expect(repository.activateDraft(policyServerId)).resolves.toEqual({ kind: "revision_required" });

    expect((await repository.testDraft({ oneTimeValues: {}, serverId: policyServerId })).kind)
      .toBe("ok");
    const activatedV2 = await repository.activateDraft(policyServerId);
    expect(activatedV2).toMatchObject({
      kind: "ok",
      value: {
        activeRevision: {
          disabledToolNames: ["create_task", "temporarily_missing"],
          revisionNumber: 2,
          validationEvidence: { toolInventory: [{ name: "create_task" }] }
        }
      }
    });
    if (activatedV2.kind !== "ok" || !activatedV2.value.activeRevision) return;

    expect((await repository.setGrant({
      canUse: true,
      groupId,
      personalSlotKeys: [],
      serverId: policyServerId,
      userId: null
    })).kind).toBe("ok");
    expect((await repository.listUserServers(userId)).find((server) => server.id === policyServerId))
      .toMatchObject({ knownToolCount: 0, tools: [] });

    const rolledBack = await repository.rollbackServer({
      revisionId: activatedV1.value.activeRevision.id,
      serverId: policyServerId
    });
    expect(rolledBack).toMatchObject({
      kind: "ok",
      value: { activeRevision: { id: activatedV1.value.activeRevision.id } }
    });
    expect(rolledBack.kind === "ok" ? rolledBack.value.activeRevision?.disabledToolNames : undefined)
      .toBeUndefined();
    expect((await repository.listUserServers(userId)).find((server) => server.id === policyServerId))
      .toMatchObject({ knownToolCount: 1 });

    const rebuilt = await repository.rebuildRevision({
      oneTimeValues: {},
      replaceDraft: true,
      revisionId: activatedV2.value.activeRevision.id,
      serverId: policyServerId
    });
    expect(rebuilt).toMatchObject({
      kind: "ok",
      value: {
        activeRevision: { disabledToolNames: ["create_task", "temporarily_missing"] },
        draft: { disabledToolNames: ["create_task", "temporarily_missing"] }
      }
    });
  });

  it("atomically queues, exclusively claims, reclaims, fences, and publishes an activation", async () => {
    const asyncDraft: McpDraftConfiguration = {
      ...draft,
      slots: draft.slots.filter((slot) => slot.slotKey !== "workspace-key")
    };
    const created = await repository.createServer({
      activate: true,
      description: "Async activation server",
      draft: asyncDraft,
      name: "Async activation MCP",
      sharedValues: { "api-key": "async-shared-secret", visibility: "team" },
      validationUserId: adminId
    });
    expect(created).toMatchObject({
      kind: "ok",
      value: {
        activation: { stage: "queued" },
        activeRevision: null,
        enabled: false
      }
    });
    if (created.kind !== "ok" || !created.value.activation) return;
    const asyncServerId = created.value.id;
    serverIds.add(asyncServerId);
    const activationId = created.value.activation.id;

    const idempotent = await repository.requestActivation({
      serverId: asyncServerId,
      validationUserId: secondAdminId
    });
    expect(idempotent).toMatchObject({
      kind: "ok",
      value: { activation: { id: activationId, stage: "queued" } }
    });

    const firstNow = new Date("2026-07-27T18:00:00.000Z");
    const firstClaim = await repository.claimActivation({
      now: firstNow,
      staleBefore: new Date(firstNow.getTime() - 60_000)
    });
    expect(firstClaim).toMatchObject({
      id: activationId,
      serverId: asyncServerId,
      validationUserId: adminId,
      values: {
        "api-key": "async-shared-secret",
        visibility: "team"
      }
    });
    if (!firstClaim) return;
    await expect(repository.heartbeatActivation({
      id: firstClaim.id,
      leaseId: firstClaim.leaseId,
      now: new Date(firstNow.getTime() + 1_000)
    })).resolves.toBe(true);
    await expect(repository.claimActivation({
      now: new Date(firstNow.getTime() + 2_000),
      staleBefore: new Date(firstNow.getTime() - 58_000)
    })).resolves.toBeNull();

    await database.mcpActivationJob.update({
      data: { updatedAt: new Date(firstNow.getTime() - 120_000) },
      where: { id: activationId }
    });
    const reclaimed = await repository.claimActivation({
      now: new Date(firstNow.getTime() + 3_000),
      staleBefore: new Date(firstNow.getTime() - 60_000)
    });
    expect(reclaimed).toMatchObject({ id: activationId, serverId: asyncServerId });
    if (!reclaimed) return;
    expect(reclaimed.leaseId).not.toBe(firstClaim.leaseId);
    expect(reclaimed.workloadToken).not.toBe(firstClaim.workloadToken);
    await expect(repository.heartbeatActivation({
      id: firstClaim.id,
      leaseId: firstClaim.leaseId,
      now: new Date(firstNow.getTime() + 4_000)
    })).resolves.toBe(false);
    await expect(repository.advanceActivation({
      id: reclaimed.id,
      leaseId: reclaimed.leaseId,
      now: new Date(firstNow.getTime() + 4_000),
      stage: "publishing"
    })).resolves.toBe(true);

    const published = await repository.publishActivation({
      claim: reclaimed,
      now: new Date(firstNow.getTime() + 5_000),
      publication: {
        evidence: { protocolVersion: "2025-06-18" },
        resolvedArtifact: {
          exactVersion: "1.0.0",
          imageRef: "toolhivelocal/example-mcp:async-1-0-0",
          imageReferenceKind: "toolhive_generated_tag",
          kind: "toolhive_local",
          materializer: "npx",
          packageName: "example-mcp",
          registryArtifactUrl: "https://registry.example.test/example-mcp-1.0.0.tgz",
          registryIntegrity: "sha512-YWJjZA==",
          sourceKind: "npm",
          toolhiveVersion: "v0.40.1"
        },
        toolInventory: [{ description: "Create a task", name: "create_task" }]
      }
    });
    expect(published).toEqual({ kind: "published" });
    const ready = await repository.listAdminServers();
    expect(ready.find((server) => server.id === asyncServerId)).toMatchObject({
      activation: { id: activationId, stage: "ready" },
      activeRevision: { revisionNumber: 1 },
      enabled: true
    });

    const retry = await repository.requestActivation({
      serverId: asyncServerId,
      validationUserId: adminId
    });
    expect(retry).toMatchObject({ kind: "ok", value: { activation: { stage: "queued" } } });
    if (retry.kind !== "ok" || !retry.value.activation) return;
    expect(retry.value.activation.id).not.toBe(activationId);
    const retryClaim = await repository.claimActivation({
      now: new Date(firstNow.getTime() + 6_000),
      staleBefore: new Date(firstNow.getTime() - 54_000)
    });
    if (!retryClaim) throw new Error("expected retry activation claim");
    await expect(repository.failActivation({
      errorCode: "mcp_draft_test_failed",
      id: retryClaim.id,
      issues: [{ code: "connection_failed", path: "source" }],
      leaseId: retryClaim.leaseId,
      now: new Date(firstNow.getTime() + 7_000)
    })).resolves.toBe(true);
    const afterFailure = (await repository.listAdminServers())
      .find((server) => server.id === asyncServerId);
    expect(afterFailure).toMatchObject({
      activation: {
        errorCode: "mcp_draft_test_failed",
        issues: [{ code: "connection_failed", path: "source" }],
        stage: "failed"
      },
      activeRevision: { revisionNumber: 1 },
      enabled: true
    });
    const activeRevisionId = afterFailure?.activeRevision?.id;

    await repository.requestActivation({ serverId: asyncServerId, validationUserId: adminId });
    const sharedConfigClaim = await repository.claimActivation({
      now: new Date(firstNow.getTime() + 8_000),
      staleBefore: new Date(firstNow.getTime() - 52_000)
    });
    if (!sharedConfigClaim) throw new Error("expected shared-config fence claim");
    await repository.updateServer({
      serverId: asyncServerId,
      sharedValues: { visibility: "private" }
    });
    await expect(repository.advanceActivation({
      id: sharedConfigClaim.id,
      leaseId: sharedConfigClaim.leaseId,
      now: new Date(firstNow.getTime() + 9_000),
      stage: "publishing"
    })).resolves.toBe(false);
    await expect(repository.publishActivation({
      claim: sharedConfigClaim,
      now: new Date(firstNow.getTime() + 9_000),
      publication: { evidence: {}, resolvedArtifact: null, toolInventory: [] }
    })).resolves.toEqual({ kind: "lease_lost" });

    await repository.requestActivation({ serverId: asyncServerId, validationUserId: adminId });
    const draftClaim = await repository.claimActivation({
      now: new Date(firstNow.getTime() + 10_000),
      staleBefore: new Date(firstNow.getTime() - 50_000)
    });
    if (!draftClaim) throw new Error("expected draft fence claim");
    await repository.updateServer({
      draft: {
        ...asyncDraft,
        source: {
          args: [],
          kind: "npm",
          packageName: "example-mcp",
          versionSelector: "1.1.0"
        }
      },
      serverId: asyncServerId
    });
    await expect(repository.publishActivation({
      claim: draftClaim,
      now: new Date(firstNow.getTime() + 11_000),
      publication: { evidence: {}, resolvedArtifact: null, toolInventory: [] }
    })).resolves.toEqual({ kind: "lease_lost" });
    await expect(database.mcpServer.findUniqueOrThrow({
      select: { activeRevisionId: true, activationJob: true, enabled: true },
      where: { id: asyncServerId }
    })).resolves.toMatchObject({
      activationJob: null,
      activeRevisionId,
      enabled: true
    });
  });

  it("hides a deleted server immediately, drains an accepted run, then removes its private graph", async () => {
    const created = await repository.createServer({
      description: "Delete lifecycle server",
      draft,
      name: "Delete lifecycle MCP",
      sharedValues: { "api-key": "delete-shared-secret", visibility: "team" }
    });
    expect(created.kind).toBe("ok");
    if (created.kind !== "ok") return;
    const deletedServerId = created.value.id;
    serverIds.add(deletedServerId);

    expect((await repository.testDraft({
      oneTimeValues: { "workspace-key": "delete-one-time-secret" },
      serverId: deletedServerId
    })).kind).toBe("ok");
    const activated = await repository.activateDraft(deletedServerId);
    expect(activated.kind).toBe("ok");
    if (activated.kind !== "ok" || !activated.value.activeRevision) return;
    const revisionId = activated.value.activeRevision.id;

    expect((await repository.setGrant({
      canUse: true,
      groupId: null,
      personalSlotKeys: ["api-key", "visibility", "workspace-key"],
      serverId: deletedServerId,
      userId
    })).kind).toBe("ok");
    expect((await repository.updateUserServer({
      enabled: true,
      serverId: deletedServerId,
      userId,
      values: {
        "workspace-key": "delete-personal-secret"
      }
    })).kind).toBe("ok");

    const preference = await database.mcpUserServer.findUniqueOrThrow({
      where: { userId_serverId: { serverId: deletedServerId, userId } }
    });
    const generation = await database.mcpRuntimeGeneration.create({
      data: {
        createdAt: new Date(Date.now() - 5 * 60_000),
        fingerprint: `delete-lifecycle-${suffix}`,
        revisionId,
        state: "ready",
        userServerId: preference.id
      }
    });
    await database.mcpUserServer.update({
      data: { desiredRuntimeGenerationId: generation.id },
      where: { id: preference.id }
    });

    const chat = await database.chat.create({
      data: {
        title: "Deleted MCP evidence",
        userId
      }
    });
    const userMessage = await database.message.create({
      data: { chatId: chat.id, content: { blocks: [] }, role: "user", status: "complete" }
    });
    const run = await database.modelRun.create({
      data: {
        chatId: chat.id,
        modelId: "fake-qsa",
        normalizedRequest: {
          mcpServers: [{ id: deletedServerId, name: "Delete lifecycle MCP" }]
        },
        provider: "fake",
        providerRequestPreview: {},
        status: "in_progress",
        userId,
        userMessageId: userMessage.id
      }
    });
    const binding = await database.mcpRunBinding.create({
      data: {
        modelRunId: run.id,
        runtimeGenerationFingerprint: generation.fingerprint,
        runtimeGenerationId: generation.id
      }
    });
    const toolCall = await database.modelRunToolCall.create({
      data: {
        arguments: { query: "retained" },
        completedAt: new Date(),
        mcpRunBindingId: binding.id,
        modelRunId: run.id,
        ordinal: 0,
        providerCallId: "delete-lifecycle-call",
        result: { content: "retained evidence" },
        roundIndex: 0,
        state: "complete",
        toolName: "delete_lifecycle__search"
      }
    });

    const deleted = await repository.deleteServer(deletedServerId);
    expect(deleted).toMatchObject({
      kind: "ok",
      value: { archivedAt: expect.any(String), enabled: false, id: deletedServerId }
    });
    await expect(database.mcpServer.findMany({
      select: { id: true },
      where: { archivedAt: null, id: deletedServerId }
    })).resolves.toEqual([]);
    await expect(repository.listUserServers(userId)).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: deletedServerId })])
    );
    await expect(repository.deleteServer(deletedServerId)).resolves.toEqual({ kind: "not_found" });

    const runtimeRepository = createPrismaMcpRuntimeRepository({
      encryptionKey: () => key,
      prisma: database
    });
    await expect(runtimeRepository.finalizeDeletedServers()).resolves.toEqual(expect.any(Number));
    await expect(database.mcpServer.findUnique({ where: { id: deletedServerId } }))
      .resolves.toMatchObject({ archivedAt: expect.any(Date), enabled: false });

    await database.modelRun.update({ data: { status: "complete" }, where: { id: run.id } });
    await expect(runtimeRepository.deleteDrainedGeneration(generation.id)).resolves.toBe(true);
    await expect(runtimeRepository.finalizeDeletedServers()).resolves.toBeGreaterThanOrEqual(1);

    await expect(database.mcpServer.findUnique({ where: { id: deletedServerId } })).resolves.toBeNull();
    await expect(database.mcpRevision.count({ where: { serverId: deletedServerId } })).resolves.toBe(0);
    await expect(database.mcpGrant.count({ where: { serverId: deletedServerId } })).resolves.toBe(0);
    await expect(database.mcpUserServer.count({ where: { serverId: deletedServerId } })).resolves.toBe(0);
    await expect(database.mcpRunBinding.findUnique({ where: { id: binding.id } })).resolves.toMatchObject({
      id: binding.id,
      runtimeGenerationId: null,
      runtimeGenerationFingerprint: generation.fingerprint
    });
    await expect(database.modelRunToolCall.findUnique({ where: { id: toolCall.id } })).resolves.toMatchObject({
      id: toolCall.id,
      result: { content: "retained evidence" },
      toolName: "delete_lifecycle__search"
    });
  });
});

describe("Prisma MCP catalog query", () => {
  it("never returns deletion tombstones to administrators", async () => {
    const findMany = vi.fn(async () => []);
    const isolated = createPrismaMcpRepository({
      encryptionKey: () => key,
      prisma: { mcpServer: { findMany } } as unknown as PrismaClient
    });

    await expect(isolated.listAdminServers()).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { displayName: "asc" },
      where: { archivedAt: null }
    }));
  });
});
