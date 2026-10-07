import { describe, expect, it, vi } from "vitest";
import { adminAttentionItemSource, decodeAdminAttentionResponse } from "../../../contracts/adminAttention";
import type { AdminHealthQueueFinding } from "../health/queues";
import type { HealthFinding } from "./healthRules";
import { queueAgeCopy, queueAttentionItems } from "./queueRules";
import { createAdminAttentionService, type AdminAttentionSources } from "./service";
import { createAdminAttentionSummaryService } from "./summary";

const stalled: AdminHealthQueueFinding = { queue: "workspace_cleanup", waiting: 4, running: 1, oldestSeconds: 5 * 3_600 };

function sources(overrides: Partial<AdminAttentionSources> = {}): AdminAttentionSources {
  return {
    dashboard: vi.fn().mockResolvedValue({ users: [] }),
    email: vi.fn().mockResolvedValue(null),
    knowledge: vi.fn().mockRejectedValue(new Error("not needed")),
    mcp: vi.fn().mockResolvedValue([]),
    memory: vi.fn().mockRejectedValue(new Error("not needed")),
    providers: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockRejectedValue(new Error("not needed")),
    systemRoles: vi.fn().mockRejectedValue(new Error("not needed")),
    ...overrides
  };
}

describe("stalled background queue attention", () => {
  it("raises one warning per stalled queue with its plain-English name, jumping to Health", () => {
    const items = queueAttentionItems([stalled, { queue: "chat_titles", waiting: 1, running: 0, oldestSeconds: 45 * 60 }]);
    expect(items).toEqual([{
      action: "Open Health", code: "queue_stalled", count: 5,
      detail: "Workspace cleanup · 5 jobs not finished, the oldest due 5 hours ago — check that its worker is running",
      id: "queue_stalled:workspace_cleanup", severity: "warn", target: { section: "health" }, title: "A background queue is stalled"
    }, expect.objectContaining({
      count: 1, id: "queue_stalled:chat_titles",
      detail: "Chat titles · 1 job not finished, the oldest due 45 minutes ago — check that its worker is running"
    })]);
    expect(adminAttentionItemSource(items[0]!)).toBe("queues");
    expect(decodeAdminAttentionResponse({ attention: { checkedAt: "2026-10-07T12:00:00.000Z", items, unavailable: ["queues"] } })
      ?.attention.items).toEqual(items);
    expect([queueAgeCopy(30), queueAgeCopy(119 * 60), queueAgeCopy(47 * 3_600), queueAgeCopy(15 * 86_400)])
      .toEqual(["1 minute", "119 minutes", "47 hours", "15 days"]);
  });

  it("lists stalled queues and names the queue source when it cannot be read", async () => {
    const listed = await createAdminAttentionService({ sources: sources({ queues: vi.fn().mockResolvedValue([stalled]) }) }).list("admin-1");
    expect(listed.items.map((item) => item.id)).toContain("queue_stalled:workspace_cleanup");
    expect(listed.unavailable).not.toContain("queues");

    const failed = await createAdminAttentionService({ sources: sources({ queues: vi.fn().mockRejectedValue(new Error("timeout")) }) }).list("admin-1");
    expect(failed.items.some((item) => item.code === "queue_stalled")).toBe(false);
    expect(failed.unavailable).toContain("queues");
  });

  it("counts stalled queues on the badge and on the Health navigation entry", async () => {
    const findings: HealthFinding[] = [{ code: "logs_dropped", lines: 2 }];
    const service = createAdminAttentionSummaryService({
      now: () => new Date("2026-10-07T12:00:00.000Z"),
      sources: {
        health: vi.fn().mockResolvedValue(findings),
        providers: vi.fn().mockResolvedValue([]),
        queues: vi.fn().mockResolvedValue([stalled])
      }
    });
    await expect(service.read()).resolves.toEqual({
      bad: 0, checkedAt: "2026-10-07T12:00:00.000Z", health: 2, unavailable: [], warn: 2
    });

    const queuesDown = createAdminAttentionSummaryService({
      sources: { health: vi.fn().mockResolvedValue([]), providers: vi.fn().mockResolvedValue([]), queues: vi.fn().mockRejectedValue(new Error("down")) }
    });
    await expect(queuesDown.read()).resolves.toMatchObject({ health: 0, unavailable: ["queues"], warn: 0 });
  });
});
