import { describe, expect, it, vi } from "vitest";
import { ADMIN_PROVIDER_SETUP_STREAM_TYPE } from "@/lib/contracts/adminProviderSetupProgress";
import { submitAdminProviderCustomSetup } from "./adminProviderCustomSetupApi";
import { submitAdminProviderQuickSetup } from "./adminProviderQuickSetupApi";

const clients = [
  { name: "quick", submit: (fetcher: typeof fetch) => submitAdminProviderQuickSetup({
    expectedState: "state-openai", provider: "openai", secret: "synthetic-key"
  }, fetcher) },
  { name: "custom", submit: (fetcher: typeof fetch) => submitAdminProviderCustomSetup({
    allowPrivateNetwork: false, apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer",
    confirmPaidRequest: true, modelId: "synthetic-model", protocol: "chat_completions",
    responseTimeoutSeconds: 300, secret: "synthetic-key"
  }, fetcher) }
];
const streaming = (body: string) => new Response(body, { headers: { "content-type": ADMIN_PROVIDER_SETUP_STREAM_TYPE } });

describe.each(clients)("$name setup response failure classification", ({ submit }) => {
  it.each([
    { code: "provider_setup_response_invalid", response: () => new Response("{malformed") },
    { code: "provider_setup_response_invalid", response: () => streaming("{malformed}\n") },
    { code: "provider_setup_response_too_large", response: () => streaming("x".repeat(65_537)) },
    { code: "provider_setup_response_too_large", response: () => new Response("x".repeat(1_048_577)) },
    { code: "provider_setup_interrupted", response: () => streaming('{"type":"result","status":200,"data":{}}') },
    { code: "provider_credential_test_failed", response: () => streaming(`${JSON.stringify({
      type: "result", status: 422, data: { error: "provider_credential_test_failed" }
    })}\n`) }
  ])("preserves $code without repeating a mutation", async ({ code, response }) => {
    const fetcher = vi.fn(async () => response());
    await expect(submit(fetcher)).resolves.toEqual({ ok: false, error: { code } });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    { code: "request_aborted", error: new DOMException("synthetic stop", "AbortError") },
    { code: "network_error", error: new TypeError("synthetic transport failure") }
  ])("keeps $code separate from application response errors", async ({ code, error }) => {
    const fetcher = vi.fn(async () => { throw error; });
    await expect(submit(fetcher)).resolves.toEqual({ ok: false, error: { code } });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reports a silent response as a timeout and releases its reader", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const fetcher = vi.fn(async () => new Response(body, { headers: { "content-type": ADMIN_PROVIDER_SETUP_STREAM_TYPE } }));
      const result = submit(fetcher);
      await vi.advanceTimersByTimeAsync(45_000);
      await expect(result).resolves.toEqual({ ok: false, error: { code: "provider_setup_timeout" } });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
