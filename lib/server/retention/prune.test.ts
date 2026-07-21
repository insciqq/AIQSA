import { describe, expect, it } from "vitest";
import {
  pruneRetention,
  shouldPruneModelRunEvent,
  shouldPruneOrphanedAttachment,
  type AttachmentDeletionClaim,
  type RetentionRepository
} from "./prune";

function fakeRepository(input: {
  authFlowTokenIds?: string[];
  authSessionIds?: string[];
  claims?: AttachmentDeletionClaim[];
  deletionJobIds?: string[];
  eventIds?: string[];
  orphanMatched?: number;
  orphanShared?: number;
  stageJobs?: number;
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
    async findPrunableModelRunEventIds() {
      return input.eventIds ?? [];
    },
    async inspectOrphanedAttachments() {
      return {
        matched: input.orphanMatched ?? 0,
        shared: input.orphanShared ?? 0
      };
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
    }
  };

  return { mutations, repository };
}

describe("retention prune rules", () => {
  it("selects only old events attached to terminal runs", () => {
    const cutoff = new Date("2026-06-01T00:00:00.000Z");

    expect(
      shouldPruneModelRunEvent(
        { createdAt: new Date("2026-05-31T23:59:59.000Z"), modelRunStatus: "complete" },
        cutoff
      )
    ).toBe(true);
    expect(
      shouldPruneModelRunEvent(
        { createdAt: new Date("2026-05-01T00:00:00.000Z"), modelRunStatus: "error" },
        cutoff
      )
    ).toBe(true);
    expect(
      shouldPruneModelRunEvent(
        { createdAt: new Date("2026-05-01T00:00:00.000Z"), modelRunStatus: "cancelled" },
        cutoff
      )
    ).toBe(true);
    expect(
      shouldPruneModelRunEvent(
        { createdAt: new Date("2026-05-01T00:00:00.000Z"), modelRunStatus: "streaming" },
        cutoff
      )
    ).toBe(false);
    expect(shouldPruneModelRunEvent({ createdAt: cutoff, modelRunStatus: "complete" }, cutoff)).toBe(false);
  });

  it("selects only old detached attachments", () => {
    const cutoff = new Date("2026-06-01T00:00:00.000Z");

    expect(
      shouldPruneOrphanedAttachment(
        { createdAt: new Date("2026-05-31T00:00:00.000Z"), messageId: null },
        cutoff
      )
    ).toBe(true);
    expect(
      shouldPruneOrphanedAttachment(
        { createdAt: new Date("2026-05-31T00:00:00.000Z"), messageId: "message-1" },
        cutoff
      )
    ).toBe(false);
    expect(shouldPruneOrphanedAttachment({ createdAt: cutoff, messageId: null }, cutoff)).toBe(false);
  });

  it("keeps dry-run read-only across every retention category", async () => {
    const state = fakeRepository({
      authFlowTokenIds: ["flow-1"],
      authSessionIds: ["session-1"],
      deletionJobIds: ["job-1"],
      eventIds: ["event-1", "event-2"],
      orphanMatched: 2,
      orphanShared: 1
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
        { claimToken: "claim", id: "job-ok", storageKey: "private/user/object-ok" },
        { claimToken: "claim", id: "job-fail", storageKey: "private/user/object-fail" }
      ],
      deletionJobIds: ["job-ok", "job-fail"],
      eventIds: ["event-1"],
      orphanMatched: 2,
      stageJobs: 2
    });

    const summary = await pruneRetention({
      dryRun: false,
      now: new Date("2026-06-11T00:00:00.000Z"),
      repository: state.repository,
      storage: {
        async deleteObject(storageKey) {
          if (storageKey.endsWith("object-fail")) {
            throw new Error(`storage failed for ${storageKey}`);
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
      modelRunEvents: { deleted: 1, matched: 1 },
      orphanedAttachments: { jobsStaged: 2, matched: 2, rowsDeleted: 2 }
    });
    expect(JSON.stringify(summary)).not.toContain("private/user");
    expect(JSON.stringify(summary)).not.toContain("storage failed");
    expect(state.mutations).toContain("complete-job:job-ok");
    expect(state.mutations).toContain("release-job:job-fail");
  });
});
