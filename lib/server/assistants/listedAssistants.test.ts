import type { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createListedAssistantService, loadAssistantRecentChatCounts, placeFeaturedAssistant } from "./listedAssistants";

const eight = ["a", "b", "c", "d", "e", "f", "g", "h"];

describe("Featured Assistant order", () => {
  it("inserts, moves and removes while keeping one position per Assistant", () => {
    expect(placeFeaturedAssistant(["a", "b"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(placeFeaturedAssistant(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(placeFeaturedAssistant(["a", "b", "c"], "c", 7)).toEqual(["a", "b", "c"]);
    expect(placeFeaturedAssistant(["a", "b", "c"], "b", null)).toEqual(["a", "c"]);
    expect(placeFeaturedAssistant(["a"], "z", null)).toEqual(["a"]);
  });

  it("allows reordering at the limit but refuses a ninth Featured Assistant", () => {
    expect(placeFeaturedAssistant(eight, "h", 0)).toEqual(["h", ...eight.slice(0, 7)]);
    expect(() => placeFeaturedAssistant(eight, "i", 0)).toThrow("assistant_featured_limit");
  });
});

function fixture(rows: Array<{ assistantId: string; featuredOrder: number | null; archived?: boolean }>, admin = true) {
  const writes: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => strings.join("?").includes("\"User\"") ? (admin ? [{ id: "admin" }] : []) : [{ lock: "" }]),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      writes.push(strings.join("?").includes("= NULL") ? "clear" : `${String(values[1])}=${String(values[0])}`);
      return 1;
    }),
    assistantPublication: {
      findMany: vi.fn(async () => rows.map((row) => ({ ...row, assistant: { archivedAt: row.archived ? new Date() : null } }))),
      findFirst: vi.fn(async () => rows.length ? { id: "publication" } : null)
    }
  };
  const repository = { revokePublication: vi.fn(async () => "revoked" as const) };
  const service = createListedAssistantService({ $transaction: (write: (client: unknown) => unknown) => write(tx) } as unknown as PrismaClient, repository);
  return { tx, writes, repository, service };
}

describe("Featured Assistant writes", () => {
  it("clears every position before assigning a dense order and drops archived entries", async () => {
    const f = fixture([{ assistantId: "a", featuredOrder: 0 }, { assistantId: "old", featuredOrder: 1, archived: true },
      { assistantId: "b", featuredOrder: 4 }, { assistantId: "c", featuredOrder: null }]);
    expect(await f.service.setFeatured("admin", "c", 1)).toEqual([
      { assistantId: "a", featuredOrder: 0 }, { assistantId: "c", featuredOrder: 1 }, { assistantId: "b", featuredOrder: 2 }
    ]);
    expect(f.writes).toEqual(["clear", "a=0", "c=1", "b=2"]);
    expect(f.tx.$queryRaw.mock.calls[1]?.[0].join("")).toContain("pg_advisory_xact_lock");
  });

  it("refuses unlisted or archived Assistants and non-administrators before writing", async () => {
    await expect(fixture([{ assistantId: "a", featuredOrder: 0 }]).service.setFeatured("admin", "x", 0))
      .rejects.toMatchObject({ code: "assistant_not_available", status: 404 });
    await expect(fixture([{ assistantId: "x", featuredOrder: null, archived: true }]).service.setFeatured("admin", "x", 0))
      .rejects.toMatchObject({ code: "assistant_not_available" });
    const denied = fixture([{ assistantId: "x", featuredOrder: null }], false);
    await expect(denied.service.setFeatured("admin", "x", 0)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(denied.writes).toEqual([]);
  });

  it("unlists through the publication revoke inside the administrator's transaction", async () => {
    const f = fixture([{ assistantId: "a", featuredOrder: 0 }]);
    await f.service.unlist("admin", "a");
    expect(f.tx.assistantPublication.findFirst).toHaveBeenCalledWith({ where: { assistantId: "a", scope: "installation" }, select: { id: true } });
    expect(f.repository.revokePublication).toHaveBeenCalledWith({ actorIsAdmin: true, assistantId: "a", publicationId: "publication", userId: "admin" }, f.tx);
    const missing = fixture([]);
    await expect(missing.service.unlist("admin", "a")).rejects.toMatchObject({ code: "assistant_not_available", status: 404 });
    expect(missing.repository.revokePublication).not.toHaveBeenCalled();
  });
});

describe("Assistant chat counts", () => {
  it("counts distinct chats in the trailing 30 days without reading when there are no Assistants", async () => {
    const queryRaw = vi.fn(async (_query: Prisma.Sql) => [{ assistantId: "a", chatCount: 3 }]);
    const db = { $queryRaw: queryRaw } as unknown as Pick<Prisma.TransactionClient, "$queryRaw">;
    expect(await loadAssistantRecentChatCounts(db, [])).toEqual(new Map());
    expect(queryRaw).not.toHaveBeenCalled();
    const counts = await loadAssistantRecentChatCounts(db, ["a", "a", "b"], new Date("2026-09-30T00:00:00.000Z"));
    expect(counts).toEqual(new Map([["a", 3]]));
    const query = queryRaw.mock.calls[0]![0];
    expect(query.sql).toContain("COUNT(DISTINCT run.\"chatId\")");
    expect(query.values).toEqual(["a", "b", new Date("2026-08-31T00:00:00.000Z")]);
  });
});
