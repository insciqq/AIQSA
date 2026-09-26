import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  createPrismaRetentionRepository,
  pruneRetention,
  type AttachmentDeletionClaim,
  type RetentionRepository
} from "./prune";

function fakeRepository(input: {
  authFlowTokenIds?: string[];
  authSessionIds?: string[];
  claims?: AttachmentDeletionClaim[];
  deletionJobIds?: string[];
  eventIds?: string[];
  exemptEventCount?: number;
  inboundMcpAuthorizationCodeIds?: string[];
  inboundMcpClientIds?: string[];
  inboundMcpGrantIds?: string[];
  inboundMcpTokenFamilyIds?: string[];
  knowledgeMatched?: number;
  knowledgeObjects?: number;
  knowledgeStageJobs?: number;
  knowledgeVersionsPurged?: number;
  orphanMatched?: number;
  orphanShared?: number;
  stageJobs?: number;
  uploadItemsMatched?: number;
  uploadItemsReleased?: number;
  uploadJobsStaged?: number;
  uploadMultipartSessions?: number;
} = {}) {
  const mutations: string[] = [];
  const repository: RetentionRepository = {
    async maintainMcpHub() { return { dispatches: { expired: 0, removed: 0 }, discoveryAttempts: { expired: 0, removed: 0 } }; },
    async claimAttachmentDeletionJobs() {
      mutations.push("claim-jobs");
      return input.claims ?? [];
    },
    async completeAttachmentDeletionJob({ id }) {
      mutations.push(`complete-job:${id}`);
      return true;
    },
    async deleteAuthFlowTokens({ ids }) {
      mutations.push(`delete-flow-tokens:${ids.join(",")}`);
      return ids.length;
    },
    async deleteAuthSessions({ ids }) {
      mutations.push(`delete-sessions:${ids.join(",")}`);
      return ids.length;
    },
    async deletePrunableInboundMcpOAuth({ candidates }) {
      mutations.push("delete-inbound-mcp-oauth");
      return {
        authorizationCodes: candidates.authorizationCodeIds.length,
        clients: candidates.clientIds.length,
        grants: candidates.grantIds.length,
        tokenFamilies: candidates.tokenFamilyIds.length
      };
    },
    async deleteModelRunEvents(ids) {
      mutations.push(`delete-events:${ids.join(",")}`);
      return ids.length;
    },
    async findClaimableAttachmentDeletionJobIds() {
      return input.deletionJobIds ?? [];
    },
    async findPrunableAuthFlowTokenIds() {
      return input.authFlowTokenIds ?? [];
    },
    async findPrunableAuthSessionIds() {
      return input.authSessionIds ?? [];
    },
    async findPrunableInboundMcpOAuth() {
      return {
        authorizationCodeIds: input.inboundMcpAuthorizationCodeIds ?? [],
        clientIds: input.inboundMcpClientIds ?? [],
        grantIds: input.inboundMcpGrantIds ?? [],
        tokenFamilyIds: input.inboundMcpTokenFamilyIds ?? []
      };
    },
    async findPrunableModelRunEventIds() {
      return input.eventIds ?? [];
    },
    async countExemptModelRunEvents() {
      return input.exemptEventCount ?? 0;
    },
    async inspectOrphanedAttachments() {
      return {
        matched: input.orphanMatched ?? 0,
        shared: input.orphanShared ?? 0
      };
    },
    async inspectStaleKnowledgePayloads() {
      return {
        matched: input.knowledgeMatched ?? 0,
        objects: input.knowledgeObjects ?? 0
      };
    },
    async inspectExpiredKnowledgeTrash() {
      return { bases: 0, sources: 0 };
    },
    async inspectExpiredKnowledgeUploadSessions() {
      return {
        items: input.uploadItemsMatched ?? 0,
        multipartSessions: input.uploadMultipartSessions ?? 0
      };
    },
    async drainKnowledgeDeletionJobs() {
      mutations.push("drain-knowledge-deletions");
      return { blocked: 0, claimed: 0, completed: 0, failed: 0, waitingForObjects: 0 };
    },
    async finalizeKnowledgeDeletionJobs() {
      mutations.push("finalize-knowledge-deletions");
      return 0;
    },
    async releaseAttachmentDeletionJob({ id }) {
      mutations.push(`release-job:${id}`);
      return true;
    },
    async stageOrphanedAttachments() {
      mutations.push("stage-attachments");
      return {
        jobsStaged: input.stageJobs ?? 0,
        matched: input.orphanMatched ?? 0,
        rowsDeleted: input.orphanMatched ?? 0,
        sharedRowsDeleted: input.orphanShared ?? 0
      };
    },
    async stageStaleKnowledgePayloads() {
      mutations.push("stage-knowledge-payloads");
      return {
        jobsStaged: input.knowledgeStageJobs ?? 0,
        matched: input.knowledgeMatched ?? 0,
        objectsReleased: input.knowledgeObjects ?? 0,
        sharedObjects: 0,
        versionsPurged: input.knowledgeVersionsPurged ?? 0
      };
    },
    async stageExpiredKnowledgeTrash() {
      mutations.push("stage-knowledge-trash");
      return { bases: 0, jobsStaged: 0, sources: 0 };
    },
    async stageExpiredKnowledgeUploadSessions() {
      mutations.push("stage-knowledge-upload-sessions");
      return {
        items: input.uploadItemsMatched ?? 0,
        itemsReleased: input.uploadItemsReleased ?? input.uploadItemsMatched ?? 0,
        jobsStaged: input.uploadJobsStaged ?? 0,
        multipartSessions: input.uploadMultipartSessions ?? 0,
        multipartSessionsReleased: input.uploadMultipartSessions ?? 0
      };
    }
  };

  return { mutations, repository };
}


type StoredRunEvent = {
  createdAt: Date;
  eventType: string;
  id: string;
  payload: unknown;
  runStatus: string;
};

const agedAt = new Date("2026-04-01T00:00:00.000Z");
const retentionNow = new Date("2026-06-11T00:00:00.000Z");

function storedEvent(id: string, eventType: string, payload: unknown, overrides: Partial<StoredRunEvent> = {}): StoredRunEvent {
  return { createdAt: agedAt, eventType, id, payload, runStatus: "complete", ...overrides };
}

function artifactEvent(artifactType: string, overrides: Partial<StoredRunEvent> = {}): StoredRunEvent {
  return storedEvent(`${artifactType}-${overrides.runStatus ?? "complete"}`, "artifact", { artifactType, payload: {} }, overrides);
}

// Evaluates only the filters retention uses; any other filter fails loudly.
function matchesWhere(row: StoredRunEvent, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const filter = condition as Record<string, unknown>;
    if (key === "OR") return (condition as Record<string, unknown>[]).some((entry) => matchesWhere(row, entry));
    if (key === "id") return (filter.in as string[]).includes(row.id);
    if (key === "createdAt") return row.createdAt < (filter.lt as Date);
    if (key === "eventType") return row.eventType === condition;
    if (key === "modelRun") return ((filter.status as { in: string[] }).in).includes(row.runStatus);
    if (key === "payload") {
      const value = (filter.path as string[]).reduce<unknown>((current, segment) =>
        current !== null && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined, row.payload);
      return value !== undefined && value === filter.equals;
    }
    throw new Error(`unsupported_retention_filter:${key}`);
  });
}

function fakeRunEventDatabase(rows: StoredRunEvent[]) {
  const stored = [...rows];
  const select = (where: Record<string, unknown>) => stored.filter((row) => matchesWhere(row, where));
  const prisma = {
    modelRunEvent: {
      async count({ where }: { where: Record<string, unknown> }) {
        return select(where).length;
      },
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        const doomed = new Set(select(where).map((row) => row.id));
        const kept = stored.filter((row) => !doomed.has(row.id));
        stored.splice(0, stored.length, ...kept);
        return { count: doomed.size };
      },
      async findMany({ take, where }: { take: number; where: Record<string, unknown> }) {
        return select(where)
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
          .slice(0, take)
          .map((row) => ({ id: row.id }));
      }
    }
  };
  return {
    ids: () => stored.map((row) => row.id).sort(),
    repository: createPrismaRetentionRepository(prisma as unknown as PrismaClient)
  };
}

function runEventMethods(repository: RetentionRepository) {
  return {
    countExemptModelRunEvents: repository.countExemptModelRunEvents,
    deleteModelRunEvents: repository.deleteModelRunEvents,
    findPrunableModelRunEventIds: repository.findPrunableModelRunEventIds
  } satisfies Partial<RetentionRepository>;
}

// Every durable answer projection a terminal run can own, plus rows whose type
// retention cannot classify. None of them may expire.
const answerProjectionEvents = [
  storedEvent("grounding", "grounding_display", { provider: "gemini" }),
  storedEvent("workspace-snapshot", "workspace_activity_snapshot", { artifactType: "workspace_activity_snapshot" }),
  ...["citation", "reasoning", "search", "generated_artifact", "context_compaction",
    "workspace_activity", "workspace_checkpoint", "image"].map((type) => artifactEvent(type)),
  storedEvent("artifact-without-type", "artifact", { payload: {} }),
  storedEvent("legacy-unknown", "legacy_delta", { artifactType: "context_status" })
];
const technicalEvents = [
  artifactEvent("context_status"),
  storedEvent("receipt", "workspace_activity_receipt", { entryId: "entry", fingerprint: "f", updateId: "update:1" })
];
const protectedTechnicalEvents = [
  artifactEvent("context_status", { runStatus: "streaming" }),
  storedEvent("recent-context", "artifact", { artifactType: "context_status" }, { createdAt: retentionNow })
];

describe("retention prune rules", () => {

  it("keeps dry-run read-only across every retention category", async () => {
    const state = fakeRepository({
      authFlowTokenIds: ["flow-1"],
      authSessionIds: ["session-1"],
      deletionJobIds: ["job-1"],
      eventIds: ["event-1", "event-2"],
      exemptEventCount: 5,
      inboundMcpAuthorizationCodeIds: ["mcp-code-1"],
      inboundMcpClientIds: ["mcp-client-1"],
      inboundMcpGrantIds: ["mcp-grant-1"],
      inboundMcpTokenFamilyIds: ["mcp-family-1"],
      knowledgeMatched: 1,
      knowledgeObjects: 2,
      orphanMatched: 2,
      orphanShared: 1,
      uploadItemsMatched: 2,
      uploadMultipartSessions: 1
    });
    const deletedObjects: string[] = [];

    const summary = await pruneRetention({
      dryRun: true,
      now: new Date("2026-06-11T00:00:00.000Z"),
      repository: state.repository,
      storage: {
        async deleteObject(storageKey) {
          deletedObjects.push(storageKey);
        }
      }
    });

    expect(summary).toMatchObject({
      attachmentDeletionJobs: { claimed: 0, completed: 0, matched: 1, objectsDeleted: 0 },
      authFlowTokens: { deleted: 0, matched: 1 },
      authSessions: { deleted: 0, matched: 1 },
      dryRun: true,
      knowledgePayloads: {
        jobsStaged: 0,
        matched: 1,
        objects: 2,
        objectsReleased: 0,
        versionsPurged: 0
      },
      knowledgeUploadSessions: {
        itemsMatched: 2,
        itemsReleased: 0,
        jobsStaged: 0,
        multipartSessionsMatched: 1,
        multipartSessionsReleased: 0
      },
      inboundMcpOAuth: {
        authorizationCodes: { deleted: 0, matched: 1 },
        clients: { deleted: 0, matched: 1 },
        grants: { deleted: 0, matched: 1 },
        tokenFamilies: { deleted: 0, matched: 1 }
      },
      modelRunEvents: { deleted: 0, exempt: 5, matched: 2 },
      orphanedAttachments: { jobsStaged: 0, matched: 2, rowsDeleted: 0, shared: 1 }
    });
    expect(state.mutations).toEqual([]);
    expect(deletedObjects).toEqual([]);
  });

  it("stages rows, prunes bounded auth data, and keeps failed object work retryable without logging keys", async () => {
    const state = fakeRepository({
      authFlowTokenIds: ["flow-1"],
      authSessionIds: ["session-1"],
      claims: [
        {
          claimToken: "claim",
          id: "job-ok",
          multipartUploadId: "multipart-1",
          storageKey: "private/user/object-ok"
        },
        {
          claimToken: "claim",
          id: "job-fail",
          multipartUploadId: null,
          storageKey: "private/user/object-fail"
        }
      ],
      deletionJobIds: ["job-ok", "job-fail"],
      eventIds: ["event-1"],
      inboundMcpAuthorizationCodeIds: ["mcp-code-1"],
      inboundMcpClientIds: ["mcp-client-1"],
      inboundMcpGrantIds: ["mcp-grant-1"],
      inboundMcpTokenFamilyIds: ["mcp-family-1"],
      knowledgeMatched: 1,
      knowledgeObjects: 2,
      knowledgeStageJobs: 2,
      knowledgeVersionsPurged: 1,
      orphanMatched: 2,
      stageJobs: 2,
      uploadItemsMatched: 2,
      uploadItemsReleased: 2,
      uploadJobsStaged: 2,
      uploadMultipartSessions: 1
    });

    const abortedUploads: Array<{ storageKey: string; uploadId: string }> = [];
    const summary = await pruneRetention({
      dryRun: false,
      now: new Date("2026-06-11T00:00:00.000Z"),
      repository: state.repository,
      storage: {
        async deleteObject(storageKey) {
          if (storageKey.endsWith("object-fail")) {
            throw new Error(`storage failed for ${storageKey}`);
          }
        },
        directMultipartUpload: {
          async abortMultipartUpload(input) {
            abortedUploads.push(input);
          },
          async completeMultipartUpload() {},
          async createMultipartUpload() {
            return { uploadId: "unused" };
          },
          async presignMultipartPart() {
            return "https://storage.example.test/unused";
          }
        }
      }
    });

    expect(summary).toMatchObject({
      attachmentDeletionJobs: {
        claimed: 2,
        completed: 1,
        failedJobs: [{ code: "object_delete_failed", id: "job-fail" }],
        matched: 2,
        objectsDeleted: 1
      },
      authFlowTokens: { deleted: 1, matched: 1 },
      authSessions: { deleted: 1, matched: 1 },
      inboundMcpOAuth: {
        authorizationCodes: { deleted: 1, matched: 1 },
        clients: { deleted: 1, matched: 1 },
        grants: { deleted: 1, matched: 1 },
        tokenFamilies: { deleted: 1, matched: 1 }
      },
      modelRunEvents: { deleted: 1, matched: 1 },
      knowledgePayloads: {
        jobsStaged: 2,
        matched: 1,
        objects: 2,
        objectsReleased: 2,
        versionsPurged: 1
      },
      knowledgeUploadSessions: {
        itemsMatched: 2,
        itemsReleased: 2,
        jobsStaged: 2,
        multipartSessionsMatched: 1,
        multipartSessionsReleased: 1
      },
      orphanedAttachments: { jobsStaged: 2, matched: 2, rowsDeleted: 2 }
    });
    expect(JSON.stringify(summary)).not.toContain("private/user");
    expect(JSON.stringify(summary)).not.toContain("storage failed");
    expect(state.mutations).toContain("complete-job:job-ok");
    expect(state.mutations).toContain("release-job:job-fail");
    expect(abortedUploads).toEqual([{
      storageKey: "private/user/object-ok",
      uploadId: "multipart-1"
    }]);
  });

  it("reports expirable technical run events and exempt answer projections without deleting in dry run", async () => {
    const database = fakeRunEventDatabase([...answerProjectionEvents, ...technicalEvents, ...protectedTechnicalEvents]);
    const before = database.ids();
    const state = fakeRepository();

    const summary = await pruneRetention({
      dryRun: true,
      now: retentionNow,
      repository: { ...state.repository, ...runEventMethods(database.repository) },
      storage: { async deleteObject() {} }
    });

    expect(summary.modelRunEvents).toEqual({
      deleted: 0,
      exempt: answerProjectionEvents.length,
      matched: technicalEvents.length
    });
    expect(database.ids()).toEqual(before);
  });

  it("expires only allow-listed technical events of aged terminal runs", async () => {
    const database = fakeRunEventDatabase([...answerProjectionEvents, ...technicalEvents, ...protectedTechnicalEvents]);
    const state = fakeRepository();

    const summary = await pruneRetention({
      dryRun: false,
      now: retentionNow,
      repository: { ...state.repository, ...runEventMethods(database.repository) },
      storage: { async deleteObject() {} }
    });

    expect(summary.modelRunEvents).toEqual({
      deleted: technicalEvents.length,
      exempt: answerProjectionEvents.length,
      matched: technicalEvents.length
    });
    expect(database.ids()).toEqual([...answerProjectionEvents, ...protectedTechnicalEvents].map((row) => row.id).sort());
  });

  it("rechecks the allow-list when deleting explicitly requested run events", async () => {
    const database = fakeRunEventDatabase([...answerProjectionEvents, ...protectedTechnicalEvents]);

    await expect(database.repository.deleteModelRunEvents(
      [...answerProjectionEvents, ...protectedTechnicalEvents].map((row) => row.id)
    )).resolves.toBe(1);
    // Only the recent terminal context meter matched; age is a selection rule.
    expect(database.ids()).not.toContain("recent-context");
    expect(database.ids()).toContain("context_status-streaming");
    expect(database.ids()).toHaveLength(answerProjectionEvents.length + 1);
  });
});
