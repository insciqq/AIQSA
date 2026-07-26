import { describe, expect, it, vi } from "vitest";
import { submitAdminProviderCustomSetup } from "./adminProviderCustomSetupApi";

const request = {
  allowPrivateNetwork: false,
  apiRoot: "https://llm.example.test/v1",
  authenticationMode: "bearer" as const,
  confirmPaidRequest: true as const,
  modelId: "vendor/model-1",
  secret: "browser-only-key"
};

const ready = {
  authenticationMode: "bearer",
  checkedAt: "2026-07-26T10:00:00.000Z",
  connectionDisplayName: "Custom provider",
  connectionId: "connection-1",
  defaultChanged: true,
  modelDisplayName: "Model 1",
  outcome: "ready",
  providerModelId: "model-1"
};

describe("custom provider setup API", () => {
  it("sends one same-origin write-only request and decodes the safe receipt", async () => {
    const fetcher = vi.fn(async () => Response.json(ready));
    await expect(submitAdminProviderCustomSetup(request, fetcher)).resolves.toEqual({
      data: ready,
      ok: true
    });
    expect(fetcher).toHaveBeenCalledWith("/api/admin/providers/custom-setup", {
      body: JSON.stringify(request),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: undefined
    });
  });

  it.each([
    { ...ready, secret: "leaked" },
    { ...ready, apiRoot: "https://private.example.test/v1" },
    { ...ready, unexpected: true },
    { ...ready, outcome: "created" },
    { ...ready, checkedAt: "not-a-timestamp" }
  ])("rejects malformed or secret-bearing success responses", async (body) => {
    const result = await submitAdminProviderCustomSetup(
      request,
      vi.fn(async () => Response.json(body))
    );
    expect(result).toEqual({
      error: { code: "provider_custom_setup_response_invalid" },
      ok: false
    });
    expect(JSON.stringify(result)).not.toContain("browser-only-key");
  });

  it("preserves only a stable server error code", async () => {
    const result = await submitAdminProviderCustomSetup(
      request,
      vi.fn(async () => Response.json({
        error: "provider_custom_setup_test_failed",
        rawBody: "must not be decoded"
      }, { status: 422 }))
    );
    expect(result).toEqual({
      error: { code: "provider_custom_setup_test_failed" },
      ok: false
    });
  });
});
