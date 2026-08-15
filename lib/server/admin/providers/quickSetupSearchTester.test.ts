import type { McpPinnedHttpRequest } from "../../mcp/safeFetch";
import { adminProviderQuickSetupPolicy } from "./quickSetupPolicy";
import { createAdminProviderQuickSetupSearchTester } from "./quickSetupSearchTester";
import { describe, expect, it, vi } from "vitest";

const publicLookup = async () => [
  { address: "93.184.216.34", family: 4 as const }
];

describe("OpenAI Search source probe", () => {
  it("sends only a bounded store-free query and retains only normalized source evidence", async () => {
    const requests: McpPinnedHttpRequest[] = [];
    const policy = adminProviderQuickSetupPolicy("openai");
    const candidate = policy.candidates[0]!;
    const tester = createAdminProviderQuickSetupSearchTester({
      network: {
        dispatch: async (request) => {
          requests.push(request);
          return Response.json({
            id: "resp-search-probe",
            model: candidate.configuration.upstreamModelId,
            output: [
              {
                action: {
                  sources: [{ title: "OpenAI", url: "https://openai.com/" }],
                  type: "search"
                },
                id: "web-search-probe",
                status: "completed",
                type: "web_search_call"
              },
              {
                content: [{
                  annotations: [{
                    title: "OpenAI",
                    type: "url_citation",
                    url: "https://openai.com/"
                  }],
                  text: "Source found.",
                  type: "output_text"
                }],
                id: "message-probe",
                role: "assistant",
                status: "completed",
                type: "message"
              }
            ],
            status: "completed",
            usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 }
          });
        },
        lookupHostname: publicLookup
      }
    });

    await expect(tester.test({
      connection: policy.connection.configuration,
      model: candidate.configuration,
      secret: "write-only-openai-key"
    })).resolves.toEqual({ normalizedSourceCount: 1, status: "available" });

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url.pathname).toBe("/v1/responses");
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer write-only-openai-key");
    const body = JSON.parse(request.body ? new TextDecoder().decode(request.body) : "null") as Record<string, unknown>;
    expect(body).toMatchObject({
      background: false,
      model: candidate.configuration.upstreamModelId,
      store: false,
      stream: false,
      tool_choice: "auto",
      tools: [{ type: "web_search" }]
    });
    expect(JSON.stringify(body)).toContain("Find the official OpenAI home page");
    expect(JSON.stringify(body)).not.toContain("attachment");
    expect(JSON.stringify(body)).not.toContain("chat history");
  });

  it("reports an unavailable probe when the provider returns no source evidence", async () => {
    const policy = adminProviderQuickSetupPolicy("openai");
    const candidate = policy.candidates[0]!;
    const tester = createAdminProviderQuickSetupSearchTester({
      network: {
        dispatch: async () => Response.json({
          id: "resp-search-probe-empty",
          model: candidate.configuration.upstreamModelId,
          output: [{
            content: [{ text: "No source.", type: "output_text" }],
            id: "message-probe",
            role: "assistant",
            status: "completed",
            type: "message"
          }],
          status: "completed",
          usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 }
        }),
        lookupHostname: publicLookup
      }
    });

    await expect(tester.test({
      connection: policy.connection.configuration,
      model: candidate.configuration,
      secret: "write-only-openai-key"
    })).resolves.toEqual({ normalizedSourceCount: 0, status: "unavailable" });
  });

  it("uses the same bounded probe for a compatible Responses model", async () => {
    const policy = adminProviderQuickSetupPolicy("openai");
    const candidate = policy.candidates[0]!;
    const tester = createAdminProviderQuickSetupSearchTester({
      network: {
        dispatch: async () => Response.json({
          id: "compatible-search-probe",
          model: "vendor/search-model",
          output: [{
            action: {
              sources: [{ title: "Source", url: "https://example.com/source" }],
              type: "search"
            },
            id: "compatible-web-search",
            status: "completed",
            type: "web_search_call"
          }, {
            content: [{
              annotations: [{
                title: "Source",
                type: "url_citation",
                url: "https://example.com/source"
              }],
              text: "Source found.",
              type: "output_text"
            }],
            id: "compatible-message",
            role: "assistant",
            status: "completed",
            type: "message"
          }],
          status: "completed",
          usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 }
        }),
        lookupHostname: publicLookup
      }
    });

    await expect(tester.test({
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://compatible.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      model: {
        ...candidate.configuration,
        adapterKind: "openai_responses_compatible",
        upstreamModelId: "vendor/search-model"
      },
      secret: "write-only-compatible-key"
    })).resolves.toEqual({ normalizedSourceCount: 1, status: "available" });
  });

  it("bounds the optional connectivity probe to the connection deadline", async () => {
    vi.useFakeTimers();
    try {
      const policy = adminProviderQuickSetupPolicy("openai");
      const candidate = policy.candidates[0]!;
      let requestSignal: AbortSignal | undefined;
      const tester = createAdminProviderQuickSetupSearchTester({
        network: {
          dispatch: async (request) => {
            requestSignal = request.signal;
            return new Promise<Response>((_resolve, reject) => {
              request.signal.addEventListener(
                "abort",
                () => reject(request.signal.reason ?? new Error("aborted")),
                { once: true }
              );
            });
          },
          lookupHostname: publicLookup
        }
      });
      const outcome = tester.test({
        connection: {
          ...policy.connection.configuration,
          responseTimeoutMs: 5_000
        },
        model: candidate.configuration,
        secret: "write-only-openai-key"
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ error, ok: false as const })
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(requestSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(requestSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(requestSignal?.aborted).toBe(true);
      await expect(outcome).resolves.toMatchObject({ ok: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
