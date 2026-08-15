// @vitest-environment node

import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("/api/health/live", () => {
  it("reports dependency-free process liveness without caching", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
