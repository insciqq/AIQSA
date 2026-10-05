import { describe, expect, it } from "vitest";
import {
  pruneRetention,
  runObjectDeletionPass,
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

});

function deletionClaim(id: string, multipartUploadId: string | null = null): AttachmentDeletionClaim {
  return { claimToken: `token-${id}`, id, multipartUploadId, storageKey: `private/user/${id}` };
}

function passRepository(batches: AttachmentDeletionClaim[][]) {
  const calls: string[] = [];
  const claimInputs: Array<{ claimableBefore: Date; limit: number; now: Date }> = [];
  const repository = {
    async claimAttachmentDeletionJobs(input: { claimableBefore: Date; limit: number; now: Date }) {
      claimInputs.push(input);
      calls.push("claim");
      return batches.shift() ?? [];
    },
    async completeAttachmentDeletionJob({ id }: { claimToken: string; id: string }) {
      calls.push(`complete:${id}`);
      return true;
    },
    async finalizeKnowledgeDeletionJobs() {
      calls.push("finalize-knowledge-deletions");
      return 1;
    },
    async releaseAttachmentDeletionJob({ errorCode, id }: {
      claimToken: string;
      errorCode: "object_delete_failed";
      id: string;
      now: Date;
    }) {
      calls.push(`release:${id}:${errorCode}`);
      return true;
    }
  };
  return { batches, calls, claimInputs, repository };
}

describe("background object deletion pass", () => {
  const now = new Date("2026-10-05T12:00:00.000Z");

  it("drains due jobs in small leased batches and settles waiting Knowledge deletions once", async () => {
    const state = passRepository([
      [deletionClaim("a"), deletionClaim("b")],
      [deletionClaim("c"), deletionClaim("d")],
      [deletionClaim("e")]
    ]);
    const deleted: string[] = [];

    const summary = await runObjectDeletionPass({
      batchSize: 2,
      maxBatches: 5,
      now: () => now,
      repository: state.repository,
      storage: { async deleteObject(storageKey) { deleted.push(storageKey); } }
    });

    expect(summary).toEqual({ batches: 3, claimed: 5, completed: 5, failed: 0, knowledgeJobsFinalized: 1 });
    expect(deleted).toEqual(["a", "b", "c", "d", "e"].map((id) => `private/user/${id}`));
    expect(state.claimInputs).toEqual(Array.from({ length: 3 }, () => ({
      claimableBefore: new Date(now.getTime() - 15 * 60 * 1000),
      limit: 2,
      now
    })));
    expect(state.calls.filter((call) => call === "finalize-knowledge-deletions")).toHaveLength(1);
    expect(state.calls.at(-1)).toBe("finalize-knowledge-deletions");
  });

  it("bounds one pass while due work remains for the next", async () => {
    const state = passRepository([
      [deletionClaim("a"), deletionClaim("b")],
      [deletionClaim("c"), deletionClaim("d")],
      [deletionClaim("e"), deletionClaim("f")]
    ]);

    const summary = await runObjectDeletionPass({
      batchSize: 2,
      maxBatches: 2,
      repository: state.repository,
      storage: { async deleteObject() {} }
    });

    expect(summary).toMatchObject({ batches: 2, claimed: 4, completed: 4 });
    expect(state.batches).toEqual([[deletionClaim("e"), deletionClaim("f")]]);
  });

  it("releases a failed deletion, ends the pass and keeps the summary content-free", async () => {
    const state = passRepository([
      [deletionClaim("broken"), deletionClaim("multipart", "upload-1")],
      [deletionClaim("later")]
    ]);

    const summary = await runObjectDeletionPass({
      batchSize: 2,
      repository: state.repository,
      storage: {
        async deleteObject(storageKey) {
          if (storageKey.endsWith("broken")) throw new Error(`storage failed for ${storageKey}`);
        }
      }
    });

    expect(summary).toEqual({ batches: 1, claimed: 2, completed: 0, failed: 2, knowledgeJobsFinalized: 0 });
    // Without an abort adapter a recorded multipart upload is never orphaned by deleting only its key.
    expect(state.calls).toEqual([
      "claim",
      "release:broken:object_delete_failed",
      "release:multipart:object_delete_failed"
    ]);
    expect(state.batches).toEqual([[deletionClaim("later")]]);
    expect(JSON.stringify(summary)).not.toMatch(/private|storage failed/u);
  });

  it("aborts a recorded multipart upload before deleting its object", async () => {
    const state = passRepository([[deletionClaim("multipart", "upload-1")]]);
    const operations: string[] = [];

    await expect(runObjectDeletionPass({
      repository: state.repository,
      storage: {
        async deleteObject(storageKey) { operations.push(`delete:${storageKey}`); },
        directMultipartUpload: {
          async abortMultipartUpload({ storageKey, uploadId }) { operations.push(`abort:${storageKey}:${uploadId}`); },
          async completeMultipartUpload() {},
          async createMultipartUpload() { return { uploadId: "unused" }; },
          async presignMultipartPart() { return "https://storage.example.test/unused"; }
        }
      }
    })).resolves.toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(operations).toEqual(["abort:private/user/multipart:upload-1", "delete:private/user/multipart"]);
  });

  it("claims nothing once its worker is stopping", async () => {
    const state = passRepository([[deletionClaim("a")]]);
    const controller = new AbortController();
    controller.abort();

    await expect(runObjectDeletionPass({
      repository: state.repository,
      signal: controller.signal,
      storage: { async deleteObject() {} }
    })).resolves.toEqual({ batches: 0, claimed: 0, completed: 0, failed: 0, knowledgeJobsFinalized: 0 });
    expect(state.calls).toEqual([]);
  });
});
