import { describe, expect, it } from "vitest";
import { pruneRetention, type AttachmentDeletionClaim, type RetentionRepository } from "./prune";

function fakeRepository(input: {
  authFlowTokenIds?: string[];
  authSessionIds?: string[];
  claims?: AttachmentDeletionClaim[];
  deletionJobIds?: string[];
  eventIds?: string[];
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

describe("retention prune rules", () => {

  it("keeps dry-run read-only across every retention category", async () => {
    const state = fakeRepository({
      authFlowTokenIds: ["flow-1"],
      authSessionIds: ["session-1"],
      deletionJobIds: ["job-1"],
      eventIds: ["event-1", "event-2"],
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
      modelRunEvents: { deleted: 0, matched: 2 },
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
});
