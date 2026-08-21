import { describe, expect, it, vi } from "vitest";
import { createPrismaExplicitMemoryRepository } from "./repository";

describe("Explicit Memory repository pagination", () => {
  it("binds category and provenance filters into the opaque cursor", async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([
        { id: "fact-2", updatedAt: new Date("2026-08-21T10:00:00.000Z") },
        { id: "fact-1", updatedAt: new Date("2026-08-21T09:00:00.000Z") }
      ])
      .mockResolvedValueOnce([]);
    const repository = createPrismaExplicitMemoryRepository({
      $queryRaw: queryRaw
    } as never);

    const first = await repository.list("user-1", {
      category: "work",
      pageSize: 1,
      sourceMode: "AUTOMATIC"
    });

    expect(first.nextCursor).toEqual(expect.any(String));
    expect(queryRaw.mock.calls[0]?.[0].values).toContain("work");
    expect(queryRaw.mock.calls[0]?.[0].values).toContain("AUTOMATIC");
    await expect(repository.list("user-1", {
      category: "goals",
      cursor: first.nextCursor,
      pageSize: 1,
      sourceMode: "AUTOMATIC"
    })).rejects.toThrow("memory_input_invalid");
    await expect(repository.list("user-1", {
      category: "work",
      cursor: first.nextCursor,
      pageSize: 1,
      sourceMode: "EXPLICIT"
    })).rejects.toThrow("memory_input_invalid");
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
