import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeMcpGuardVerdict, mcpGuardRequest } from "../mcp/guardPrompt";
import { createProviderRuntimeBinding, normalizeProviderExecutionSnapshot } from "./runtimeFactory";
import { fakeMcpGuardResponse, FAKE_MCP_GUARD_REASON, startFakeMcpGuardProvider } from "@/tests/support/fakeMcpGuardProvider";

afterEach(() => vi.unstubAllEnvs());

describe("synthetic MCP guard provider", () => {
  it.each(["allow", "ask", "failure", "malformed"] as const)("serves the scripted %s through the real structured-output adapter with fake fetch", async verdict => {
    const snapshot = normalizeProviderExecutionSnapshot({ version: 1, connectionId: "synthetic", connectionDisplayName: "Synthetic",
      credentialId: "synthetic-key", credentialVersionId: "synthetic-version", providerModelId: "synthetic-model", modelDisplayName: "Synthetic",
      providerFamily: "openai_compatible", connection: { apiRoot: "http://127.0.0.1:12345/v1", allowPrivateNetwork: true,
        authenticationMode: "none", responseTimeoutMs: 20_000 }, model: { adapterKind: "openai_responses_compatible",
        answerSelectable: false, modelClass: "answer", upstreamModelId: "synthetic-mcp-guard", defaultParams: {},
        capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false, structuredOutput: true } } });
    const fetchFn = vi.fn<typeof fetch>(async () => {
      const response = fakeMcpGuardResponse(verdict);
      return Response.json(response.body, { status: response.status });
    });
    const runtime = createProviderRuntimeBinding({ snapshot, secret: null, options: { allowFake: false, disableRequestRetries: true, fetchFn } });
    const request = mcpGuardRequest(["Create an issue"], { serverName: "Synthetic", toolName: "create_issue", arguments: { title: "Example" } }, null)!;
    const result = runtime.structuredOutputAdapter!.execute(request);
    if (verdict === "failure") await expect(result).rejects.toThrow();
    else if (verdict === "malformed") expect(decodeMcpGuardVerdict(await result)).toBeNull();
    else await expect(result).resolves.toEqual({ decision: verdict, reason: verdict === "ask" ? FAKE_MCP_GUARD_REASON : "You requested this change." });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refuses to start a fixture endpoint without test-mode authorization", async () => {
    vi.stubEnv("AIQSA_TEST_MODE", "0");
    await expect(startFakeMcpGuardProvider()).rejects.toThrow("fake_provider_not_allowed");
    vi.stubEnv("AIQSA_TEST_MODE", "1");
    vi.stubEnv("NODE_ENV", "production");
    await expect(startFakeMcpGuardProvider()).rejects.toThrow("fake_provider_not_allowed");
  });
});
