import { describe, expect, it, vi } from "vitest";
import { createListMemoryConsumerItemsHandler } from "./handlers";

function dependencies() {
  const list = vi.fn(async () => ({ items: [], nextCursor: null }));
  return {
    deps: {
      resolveAuth: vi.fn(async () => ({ userId: "user-1" })),
      service: { list }
    } as never,
    list
  };
}

describe("Memory consumer handlers", () => {
  it("passes bounded category and provenance filters to the service", async () => {
    const fixture = dependencies();
    const response = await createListMemoryConsumerItemsHandler(fixture.deps)(
      new Request(
        "http://test/api/me/memories?category=WORK&pageSize=7&provenance=LEARNED"
      )
    );

    expect(response.status).toBe(200);
    expect(fixture.list).toHaveBeenCalledWith("user-1", {
      category: "WORK",
      pageSize: 7,
      provenance: "LEARNED"
    });
  });

  it("rejects duplicate, unknown, and out-of-vocabulary filters", async () => {
    for (const query of [
      "category=WORK&category=GOALS",
      "category=PRIVATE",
      "provenance=ALL",
      "technicalState=READY"
    ]) {
      const fixture = dependencies();
      const response = await createListMemoryConsumerItemsHandler(fixture.deps)(
        new Request(`http://test/api/me/memories?${query}`)
      );
      expect(response.status).toBe(400);
      expect(fixture.list).not.toHaveBeenCalled();
    }
  });
});
