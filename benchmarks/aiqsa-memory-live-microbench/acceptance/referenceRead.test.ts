import { describe, expect, it, vi } from "vitest";
import { MemoryConsumerServiceError } from "../../../lib/server/memory/consumer/service";
import { missingMemoryReference } from "./referenceRead";

describe("native reference absence evidence", () => {
  it("checks the exact owner/reference and rejects a readable fact as missing", async () => {
    const get = vi.fn(async () => ({}));
    expect(await missingMemoryReference(get, "owner", "owned-ref")).toBe(false);
    expect(get).toHaveBeenCalledWith("owner", "owned-ref");
  });

  it("accepts only the service's authoritative not-found outcome", async () => {
    const get = vi.fn().mockRejectedValue(new MemoryConsumerServiceError("memory_not_found"));
    expect(await missingMemoryReference(get, "owner", "owned-ref")).toBe(true);
    get.mockRejectedValue(new MemoryConsumerServiceError("memory_unavailable"));
    await expect(missingMemoryReference(get, "owner", "owned-ref")).rejects.toThrow("memory_unavailable");
    get.mockRejectedValue(new Error("memory_not_found"));
    await expect(missingMemoryReference(get, "owner", "owned-ref")).rejects.toThrow();
  });
});
