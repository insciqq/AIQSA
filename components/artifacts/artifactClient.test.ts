import { afterEach, describe, expect, it, vi } from "vitest";
import { artifactRequest } from "./artifactClient";

const respond = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));

describe("artifact request failures", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tells the owner that a busy server saved nothing and that a later retry helps, apart from other failures", async () => {
    respond(429, { error: "artifact_server_busy" });
    await expect(artifactRequest("/api/artifacts/a/duplicate", { method: "POST" })).rejects.toMatchObject({
      name: "ArtifactRequestError", status: 429, code: "artifact_server_busy",
      message: "The server is busy creating other artifacts, so nothing was saved. Try again in a minute." });
    respond(429, { error: "rate_limit_exceeded" });
    await expect(artifactRequest("/api/artifacts/a/publish", { method: "POST" })).rejects.toMatchObject({
      status: 429, code: "rate_limit_exceeded", message: "The server is busy right now. Try again in a moment." });
    respond(400, { error: "artifact_server_busy_elsewhere" });
    await expect(artifactRequest("/api/artifacts/a/duplicate", { method: "POST" })).rejects.toMatchObject({
      status: 400, message: "The request could not finish. Try again." });
  });
});
