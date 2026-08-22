import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  latestProjectEventCursor,
  notifyProjectEvent,
  parseProjectEventCursor,
  projectCursorNeedsResync,
  projectEventAccess,
  safeProjectEventDelivery,
  safeProjectEventDeliveries,
  safeProjectEventCategory,
  subscribeProjectEvents
} from "./events";

function prismaWithEvents(input: { count: number; oldest: bigint | null }): PrismaClient {
  return {
    projectEvent: {
      count: vi.fn().mockResolvedValue(input.count),
      findFirst: vi.fn().mockResolvedValue(
        input.oldest === null ? null : { sequence: input.oldest }
      )
    }
  } as unknown as PrismaClient;
}

describe("Project event cursors", () => {
  it("accepts only non-negative decimal cursors", () => {
    expect(parseProjectEventCursor("42")).toBe(42n);
    expect(parseProjectEventCursor("-1")).toBeNull();
    expect(parseProjectEventCursor("1.5")).toBeNull();
  });

  it("anchors canonical resync at the latest durable Project cursor", async () => {
    const prisma = {
      projectEvent: { findFirst: vi.fn().mockResolvedValue({ sequence: 57n }) }
    } as unknown as PrismaClient;
    await expect(latestProjectEventCursor(prisma, "project-a")).resolves.toBe(57n);
  });

  it("does not confuse another Project's global sequence gap with expiry", async () => {
    const prisma = prismaWithEvents({ count: 12, oldest: 900n });
    await expect(projectCursorNeedsResync(prisma, { after: 0n, projectId: "project-a" }))
      .resolves.toBe(false);
    await expect(projectCursorNeedsResync(prisma, { after: 20n, projectId: "project-a" }))
      .resolves.toBe(false);
  });

  it("requires resync when a bounded Project window has advanced past the cursor", async () => {
    const prisma = prismaWithEvents({ count: 10_000, oldest: 900n });
    await expect(projectCursorNeedsResync(prisma, { after: 20n, projectId: "project-a" }))
      .resolves.toBe(true);
  });

  it("keeps archived Projects subscribed so lifecycle changes remain observable", async () => {
    const prisma = {
      project: {
        findUnique: vi.fn().mockResolvedValue({
          accessRevision: 2,
          grants: [{ group: null, groupId: null, role: "VIEWER", userId: "user-a" }],
          id: "project-a",
          instructionsRevision: 3,
          memoryRevision: 4,
          policyRevision: 5,
          status: "ARCHIVED"
        })
      },
      user: {
        findFirst: vi.fn().mockResolvedValue({ groups: [], id: "user-a" })
      }
    } as unknown as PrismaClient;

    await expect(projectEventAccess(prisma, { projectId: "project-a", userId: "user-a" }))
      .resolves.toEqual(expect.objectContaining({ status: "ARCHIVED" }));
  });

  it("collapses database event types to safe invalidation categories", () => {
    expect(safeProjectEventCategory("message_created")).toBe("message_changed");
    expect(safeProjectEventCategory("run_output_changed")).toBe("run_changed");
    expect(safeProjectEventCategory("run_tool_changed")).toBe("run_changed");
    expect(safeProjectEventCategory("unknown_internal_event")).toBe("project_changed");
  });

  it("reconstructs a current safe chat delta for a persisted message event", async () => {
    const prisma = {
      chat: {
        findMany: vi.fn().mockResolvedValue([{
          _count: { messages: 2, modelRuns: 1 },
          activeLeafMessageId: "message-2",
          archived: false,
          createdAt: new Date("2026-08-17T10:00:00.000Z"),
          createdByDisplayName: "Owner",
          createdByUserId: "user-owner",
          defaultKnowledgePlan: { baseIds: [] },
          defaultProviderModel: { connectionId: "fake", id: "fake-model" },
          id: "chat-1",
          pinned: false,
          projectFolderId: null,
          projectId: "project-a",
          title: "Shared question",
          updatedAt: new Date("2026-08-17T10:01:00.000Z")
        }])
      },
      message: { findMany: vi.fn().mockResolvedValue([{ chatId: "chat-1", id: "message-2" }]) },
      modelRun: { findMany: vi.fn().mockResolvedValue([]) },
      projectKnowledgeBaseBinding: { findMany: vi.fn().mockResolvedValue([]) },
      projectModelBinding: {
        findMany: vi.fn().mockResolvedValue([{
          providerModel: {
            activeConfig: { adapterKind: "fake" },
            activeVersion: 1,
            connection: {
              activeConfig: { adapterKind: "fake" },
              activeVersion: 1,
              defaultCredential: null,
              enabled: true,
              family: "fake"
            },
            connectionId: "fake",
            enabled: true,
            id: "fake-model",
            modelClass: "answer"
          }
        }])
      }
    } as unknown as PrismaClient;

    await expect(safeProjectEventDelivery(prisma, "project-a", {
      entityId: "message-2",
      entityType: "message",
      eventType: "message_changed",
      sequence: 42n
    })).resolves.toEqual({
      category: "run_changed",
      chat: expect.objectContaining({
        activeRun: true,
        id: "chat-1",
        messageCount: 2,
        projectId: "project-a"
      }),
      chatId: "chat-1",
      revision: "42"
    });
  });

  it("delivers resource invalidation without persisting or projecting private identity", async () => {
    const prisma = {} as PrismaClient;
    await expect(safeProjectEventDelivery(prisma, "project-a", {
      entityId: "private-resource-id",
      entityType: "resource",
      eventType: "resource_detached",
      sequence: 43n
    })).resolves.toEqual({ category: "resource_changed", revision: "43" });
  });

  it("keeps subscriptions in one global hub and makes stale unsubscribe closures harmless", async () => {
    const listener = vi.fn();
    const unsubscribeOld = subscribeProjectEvents("project-hub-test", listener);
    notifyProjectEvent("project-hub-test");
    expect(listener).toHaveBeenCalledOnce();

    unsubscribeOld();
    unsubscribeOld();
    const unsubscribeCurrent = subscribeProjectEvents("project-hub-test", listener);
    unsubscribeOld();
    notifyProjectEvent("project-hub-test");
    expect(listener).toHaveBeenCalledTimes(2);

    vi.resetModules();
    const reloaded = await import("./events");
    reloaded.notifyProjectEvent("project-hub-test");
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribeCurrent();
    reloaded.notifyProjectEvent("project-hub-test");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("deduplicates repeated chat projections and loads shared authority once per batch", async () => {
    const chat = {
      _count: { messages: 3, modelRuns: 1 },
      activeLeafMessageId: "message-3",
      archived: false,
      createdAt: new Date("2026-08-17T10:00:00.000Z"),
      createdByDisplayName: "Owner",
      createdByUserId: "user-owner",
      defaultKnowledgePlan: null,
      defaultProviderModel: { connectionId: "fake", id: "fake-model" },
      id: "chat-1",
      pinned: false,
      projectFolderId: null,
      projectId: "project-a",
      title: "Shared question",
      updatedAt: new Date("2026-08-17T10:02:00.000Z")
    };
    const prisma = {
      chat: { findMany: vi.fn().mockResolvedValue([chat]) },
      message: {
        findMany: vi.fn().mockResolvedValue([
          { chatId: "chat-1", id: "message-2" },
          { chatId: "chat-1", id: "message-3" }
        ])
      },
      modelRun: {
        findMany: vi.fn().mockResolvedValue([{ chatId: "chat-1", id: "run-1" }])
      },
      projectKnowledgeBaseBinding: { findMany: vi.fn().mockResolvedValue([]) },
      projectModelBinding: {
        findMany: vi.fn().mockResolvedValue([{
          providerModel: {
            activeConfig: { adapterKind: "fake" },
            activeVersion: 1,
            connection: {
              activeConfig: { adapterKind: "fake" },
              activeVersion: 1,
              defaultCredential: null,
              enabled: true,
              family: "fake"
            },
            connectionId: "fake",
            enabled: true,
            id: "fake-model",
            modelClass: "answer"
          }
        }])
      }
    } as unknown as PrismaClient;

    const deliveries = await safeProjectEventDeliveries(prisma, "project-a", [
      { entityId: "message-2", entityType: "message", eventType: "message_changed", sequence: 50n },
      { entityId: "message-3", entityType: "message", eventType: "message_changed", sequence: 51n },
      { entityId: "run-1", entityType: "run", eventType: "run_changed", sequence: 52n },
      { entityId: "chat-1", entityType: "chat", eventType: "project_chat_created", sequence: 53n }
    ]);

    expect(deliveries).toHaveLength(4);
    expect(deliveries.every((delivery) => delivery.chatId === "chat-1")).toBe(true);
    expect(prisma.message.findMany).toHaveBeenCalledOnce();
    expect(prisma.modelRun.findMany).toHaveBeenCalledOnce();
    expect(prisma.chat.findMany).toHaveBeenCalledOnce();
    expect(prisma.projectKnowledgeBaseBinding.findMany).toHaveBeenCalledOnce();
    expect(prisma.projectModelBinding.findMany).toHaveBeenCalledOnce();
  });
});
