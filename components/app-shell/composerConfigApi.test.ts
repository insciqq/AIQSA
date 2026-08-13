import { beforeEach, describe, expect, it, vi } from "vitest";
import { shellFetch } from "@/components/app-shell/shellApi";
import { decodeComposerConfigResponse } from "@/lib/contracts/composerConfig";
import { ComposerConfigApiError, fetchComposerConfig } from "./composerConfigApi";

vi.mock("@/components/app-shell/shellApi", () => ({
  shellFetch: vi.fn()
}));

vi.mock("@/lib/contracts/composerConfig", () => ({
  decodeComposerConfigResponse: vi.fn()
}));

describe("composer-config API client", () => {
  beforeEach(() => {
    vi.mocked(shellFetch).mockReset();
    vi.mocked(decodeComposerConfigResponse).mockReset();
  });

  it("loads the single no-store bootstrap and returns the decoded projection", async () => {
    const config = { assistants: [], catalog: {}, knowledgeBases: [], mcpServers: [] };
    vi.mocked(shellFetch).mockResolvedValue(Response.json({ composerConfig: {} }));
    vi.mocked(decodeComposerConfigResponse).mockReturnValue(config as never);

    await expect(fetchComposerConfig()).resolves.toBe(config);
    expect(shellFetch).toHaveBeenCalledWith("/api/me/composer-config", expect.objectContaining({
      cache: "no-store",
      credentials: "same-origin"
    }));
  });

  it("fails closed on malformed success and neutralizes unknown server errors", async () => {
    vi.mocked(shellFetch).mockResolvedValueOnce(Response.json({ composerConfig: {} }));
    vi.mocked(decodeComposerConfigResponse).mockReturnValueOnce(null);
    await expect(fetchComposerConfig()).rejects.toMatchObject({
      code: "composer_config_malformed",
      status: 502
    });

    vi.mocked(shellFetch).mockResolvedValueOnce(Response.json(
      { error: "credential_secret_invalid" },
      { status: 500 }
    ));
    await expect(fetchComposerConfig()).rejects.toEqual(
      new ComposerConfigApiError("composer_config_unavailable", 500)
    );
  });
});
