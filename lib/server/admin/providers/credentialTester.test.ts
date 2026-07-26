import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpPinnedHttpRequest } from "../../mcp/safeFetch";
import {
  AdminProviderCredentialTestError,
  createAdminProviderCredentialTester,
  MAX_PROVIDER_CREDENTIAL_TEST_MODELS,
  type AdminProviderCredentialTesterInput
} from "./credentialTester";

const publicLookup = async () => [
  { address: "93.184.216.34", family: 4 as const }
];

function input(
  family: AdminProviderCredentialTesterInput["family"],
  secret: AdminProviderCredentialTesterInput["secret"] = "exact-secret"
): AdminProviderCredentialTesterInput {
  return {
    connection: {
      allowPrivateNetwork: false,
      apiRoot: `https://${family}.example.test/v1/`
    },
    family,
    secret
  };
}

function catalog(ids: string[], status = 200): Response {
  return new Response(JSON.stringify({
    data: ids.map((id) => ({ id, ignored: "remote metadata" }))
  }), {
    headers: { "content-type": "application/json" },
    status
  });
}

function expectStableFailure(error: unknown, forbiddenValue?: string): void {
  expect(error).toBeInstanceOf(AdminProviderCredentialTestError);
  expect(error).toMatchObject({
    code: "provider_credential_test_failed",
    message: "provider_credential_test_failed",
    name: "AdminProviderCredentialTestError"
  });
  if (forbiddenValue) expect(String(error)).not.toContain(forbiddenValue);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("admin provider credential tester", () => {
  it.each([
    {
      family: "openai" as const,
      path: "/v1/models",
      expectedHeaders: {
        authorization: "Bearer exact-secret"
      }
    },
    {
      family: "openai_compatible" as const,
      path: "/v1/models",
      expectedHeaders: {
        authorization: "Bearer exact-secret"
      }
    },
    {
      family: "anthropic" as const,
      path: "/v1/models",
      expectedHeaders: {
        "anthropic-version": "2023-06-01",
        "x-api-key": "exact-secret"
      }
    },
    {
      family: "gemini" as const,
      path: "/v1/models",
      expectedHeaders: {
        "x-goog-api-key": "exact-secret"
      }
    },
    {
      family: "openrouter" as const,
      path: "/v1/models/user",
      expectedHeaders: {
        authorization: "Bearer exact-secret"
      }
    }
  ])("uses the reviewed $family catalog path and authentication headers", async ({
    expectedHeaders,
    family,
    path
  }) => {
    const requests: McpPinnedHttpRequest[] = [];
    const tester = createAdminProviderCredentialTester({
      network: {
        dispatch: async (request) => {
          requests.push(request);
          return family === "gemini"
            ? new Response(JSON.stringify({
                models: ["model-b", "model-a", "model-b"].map((name) => ({ name }))
              }))
            : catalog(["model-b", "model-a", "model-b"]);
        },
        lookupHostname: publicLookup
      }
    });

    await expect(tester.test(input(family))).resolves.toEqual({
      method: "models_catalog",
      modelIds: ["model-b", "model-a"]
    });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url.pathname).toBe(path);
    expect(request.method).toBe("GET");
    expect(request.body).toBeNull();
    expect(request.headers.get("accept")).toBe("application/json");
    for (const [name, value] of Object.entries(expectedHeaders)) {
      expect(request.headers.get(name)).toBe(value);
    }
    if (family === "anthropic" || family === "gemini") {
      expect(request.headers.has("authorization")).toBe(false);
    } else {
      expect(request.headers.has("x-api-key")).toBe(false);
      expect(request.headers.has("anthropic-version")).toBe(false);
    }
  });

  it("normalizes Gemini catalog resource names before policy matching", async () => {
    const tester = createAdminProviderCredentialTester({
      network: {
        dispatch: async () => new Response(JSON.stringify({
          models: [
            "models/gemini-3.6-flash",
            "gemini-3.5-flash",
            "models/gemini-3.6-flash",
            "models/gemini-3.5-flash-lite"
          ].map((name) => ({ name }))
        })),
        lookupHostname: publicLookup
      }
    });

    await expect(tester.test(input("gemini"))).resolves.toEqual({
      method: "models_catalog",
      modelIds: [
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite"
      ]
    });
  });

  it("resolves a lazy secret once and never includes it in the result", async () => {
    const source = vi.fn(async () => "  lazy-exact-secret  ");
    const requests: McpPinnedHttpRequest[] = [];
    const tester = createAdminProviderCredentialTester({
      network: {
        dispatch: async (request) => {
          requests.push(request);
          return catalog(["model-1"]);
        },
        lookupHostname: publicLookup
      }
    });

    const result = await tester.test(input("openai", source));
    expect(source).toHaveBeenCalledOnce();
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer lazy-exact-secret");
    expect(JSON.stringify(result)).not.toContain("lazy-exact-secret");
  });

  it.each([
    { data: {} },
    { data: [null] },
    { data: [{}] },
    { data: [{ id: " " }] },
    { data: [{ id: "bad\u0000id" }] },
    { data: [{ id: "x".repeat(257) }] },
    { models: [{ id: "model-1" }] }
  ])("rejects a non-standard catalog without reflecting it", async (body) => {
    const tester = createAdminProviderCredentialTester({
      network: {
        dispatch: async () => new Response(JSON.stringify(body)),
        lookupHostname: publicLookup
      }
    });
    try {
      await tester.test(input("openai"));
      throw new Error("Expected the credential catalog to be rejected.");
    } catch (error) {
      expectStableFailure(error);
    }
  });

  it("rejects catalog count and response-byte overflows with one stable error", async () => {
    const responses = [
      catalog(Array.from(
        { length: MAX_PROVIDER_CREDENTIAL_TEST_MODELS + 1 },
        (_value, index) => `model-${index}`
      )),
      catalog(["model-with-a-body-that-exceeds-the-test-limit"])
    ];
    const tester = createAdminProviderCredentialTester({
      network: {
        dispatch: async () => responses.shift()!,
        lookupHostname: publicLookup
      }
    });

    try {
      await tester.test(input("anthropic"));
      throw new Error("Expected catalog count overflow.");
    } catch (error) {
      expectStableFailure(error);
    }

    vi.stubEnv("AIQSA_PROVIDER_RESPONSE_MAX_BYTES", "16");
    try {
      await tester.test(input("anthropic"));
      throw new Error("Expected catalog byte overflow.");
    } catch (error) {
      expectStableFailure(error);
    }
  });

  it("discards non-success bodies and never exposes the exact secret or remote error", async () => {
    const secret = "never-reflect-this-secret";
    const remoteError = `invalid key ${secret}`;
    const tester = createAdminProviderCredentialTester({
      network: {
        dispatch: async () => new Response(remoteError, { status: 401 }),
        lookupHostname: publicLookup
      }
    });

    try {
      await tester.test(input("openrouter", secret));
      throw new Error("Expected a non-success response.");
    } catch (error) {
      expectStableFailure(error, secret);
      expect(String(error)).not.toContain(remoteError);
    }
  });

  it("keeps one timeout through body consumption and rejects redirects", async () => {
    vi.stubEnv("AIQSA_PROVIDER_TIMEOUT_MS", "10");
    let cancellationReason: unknown;
    const stalled = createAdminProviderCredentialTester({
      network: {
        dispatch: async () => new Response(new ReadableStream<Uint8Array>({
          cancel(reason) {
            cancellationReason = reason;
          },
          pull() {
            // Keep the body pending beyond the absolute credential-test deadline.
          }
        })),
        lookupHostname: publicLookup
      }
    });
    try {
      await stalled.test(input("openai"));
      throw new Error("Expected a timeout.");
    } catch (error) {
      expectStableFailure(error);
    }
    expect(cancellationReason).toBeInstanceOf(Error);

    const redirected = createAdminProviderCredentialTester({
      network: {
        dispatch: async () => new Response(null, {
          headers: { location: "https://attacker.example.test/models" },
          status: 302
        }),
        lookupHostname: publicLookup
      }
    });
    try {
      await redirected.test(input("openai"));
      throw new Error("Expected a redirect to be rejected.");
    } catch (error) {
      expectStableFailure(error);
    }
  });
});
