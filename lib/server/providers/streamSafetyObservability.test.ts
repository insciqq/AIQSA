import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderStreamTooLargeError } from "./streamSafety";
import { warnProviderStreamSafetyOnce } from "./streamSafetyObservability";

describe("provider stream safety observability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits one allowlisted warning for an error and its propagated immutable report", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = new ProviderStreamTooLargeError({
      maxBytes: 1024,
      observedBytes: 1025,
      snapshot: { durationMs: 77, totalStreamBytes: 1025 }
    });
    const identity = {
      adapterKind: "anthropic_messages",
      connectionId: "connection-1",
      providerFamily: "anthropic",
      providerModelId: "provider-model-1"
    };

    expect(warnProviderStreamSafetyOnce(error, identity)).toBe(true);
    expect(warnProviderStreamSafetyOnce(error.report, identity)).toBe(false);

    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warning.mock.calls[0]?.[0]))).toEqual({
      adapterKind: "anthropic_messages",
      code: "provider_stream_too_large",
      connectionId: "connection-1",
      durationMs: 77,
      event: "provider_stream_safety_terminated",
      limit: 1024,
      observed: 1025,
      providerFamily: "anthropic",
      providerModelId: "provider-model-1",
      termination: "total_limit",
      totalStreamBytes: 1025,
      unit: "bytes"
    });
  });
});
