import { describe, expect, it, vi } from "vitest";
import type {
  McpPinnedHttpRequest,
  McpResolvedAddress
} from "../mcp/safeFetch";
import {
  createProviderSafeFetch,
  ProviderSafeFetchError
} from "./providerSafeFetch";

const PUBLIC_ADDRESS: McpResolvedAddress = {
  address: "93.184.216.34",
  family: 4
};

async function expectCode(
  operation: Promise<unknown>,
  code: ProviderSafeFetchError["code"]
): Promise<void> {
  try {
    await operation;
    throw new Error("Expected provider safe fetch to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderSafeFetchError);
    expect(error).toMatchObject({ code, message: code, name: "ProviderSafeFetchError" });
  }
}

describe("provider SSRF-safe fetch", () => {
  it("checks DNS, pins an allowed public address, and restricts requests to the configured origin", async () => {
    const requests: McpPinnedHttpRequest[] = [];
    const lookupHostname = vi.fn(async () => [PUBLIC_ADDRESS]);
    const safeFetch = createProviderSafeFetch({
      configuration: {
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/api/v1"
      },
      dispatch: async (request) => {
        requests.push(request);
        return new Response("ok");
      },
      lookupHostname
    });

    await expect(
      safeFetch("https://provider.example.test/api/v1/models", {
        headers: { authorization: "Bearer draft-key" }
      }).then((response) => response.text())
    ).resolves.toBe("ok");

    expect(lookupHostname).toHaveBeenCalledWith("provider.example.test");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      address: PUBLIC_ADDRESS,
      method: "GET"
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer draft-key");

    await expectCode(
      safeFetch("https://other.example.test/api/v1/models"),
      "provider_http_origin_forbidden"
    );
    await expectCode(
      safeFetch("https://provider.example.test:444/api/v1/models"),
      "provider_http_origin_forbidden"
    );
    expect(lookupHostname).toHaveBeenCalledTimes(1);
  });

  it.each([
    { address: "10.0.0.8", family: 4 as const },
    { address: "172.16.2.3", family: 4 as const },
    { address: "192.168.1.4", family: 4 as const },
    { address: "127.0.0.1", family: 4 as const },
    { address: "fc00::8", family: 6 as const },
    { address: "::1", family: 6 as const },
    { address: "::ffff:127.0.0.1", family: 6 as const }
  ])("allows explicit private HTTP only for $address", async (record) => {
    const dispatch = vi.fn(async () => new Response("local"));
    const safeFetch = createProviderSafeFetch({
      configuration: {
        allowPrivateNetwork: true,
        apiRoot: "http://local-provider.example.test:11434/v1"
      },
      dispatch,
      lookupHostname: async () => [record]
    });

    await expect(
      safeFetch("http://local-provider.example.test:11434/v1/models").then((response) =>
        response.text()
      )
    ).resolves.toBe("local");
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it.each([
    { address: "0.0.0.0", family: 4 as const },
    { address: "100.64.0.1", family: 4 as const },
    { address: "169.254.169.254", family: 4 as const },
    { address: "192.0.2.1", family: 4 as const },
    { address: "198.18.0.1", family: 4 as const },
    { address: "224.0.0.1", family: 4 as const },
    { address: "240.0.0.1", family: 4 as const },
    { address: "::", family: 6 as const },
    { address: "::ffff:169.254.169.254", family: 6 as const },
    { address: "fe80::1", family: 6 as const },
    { address: "ff02::1", family: 6 as const },
    { address: "2001:db8::1", family: 6 as const }
  ])("keeps dangerous special-use address $address blocked with private opt-in", async (record) => {
    const dispatch = vi.fn(async () => new Response("unexpected"));
    const safeFetch = createProviderSafeFetch({
      configuration: {
        allowPrivateNetwork: true,
        apiRoot: "https://local-provider.example.test/v1"
      },
      dispatch,
      lookupHostname: async () => [record]
    });

    await expectCode(
      safeFetch("https://local-provider.example.test/v1/models"),
      "provider_http_address_forbidden"
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("blocks private HTTPS without opt-in and public HTTP even with opt-in", async () => {
    const noPrivate = createProviderSafeFetch({
      configuration: {
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1"
      },
      dispatch: async () => new Response("unexpected"),
      lookupHostname: async () => [{ address: "10.0.0.5", family: 4 }]
    });
    await expectCode(
      noPrivate("https://provider.example.test/v1/models"),
      "provider_http_address_forbidden"
    );

    const publicHttp = createProviderSafeFetch({
      configuration: {
        allowPrivateNetwork: true,
        apiRoot: "http://provider.example.test/v1"
      },
      dispatch: async () => new Response("unexpected"),
      lookupHostname: async () => [PUBLIC_ADDRESS]
    });
    await expectCode(
      publicHttp("http://provider.example.test/v1/models"),
      "provider_http_address_forbidden"
    );
  });

  it("fails closed for mixed DNS answers and rejects redirects without a second lookup", async () => {
    const mixedDispatch = vi.fn(async () => new Response("unexpected"));
    const mixed = createProviderSafeFetch({
      configuration: {
        allowPrivateNetwork: true,
        apiRoot: "https://provider.example.test/v1"
      },
      dispatch: mixedDispatch,
      lookupHostname: async () => [
        { address: "10.0.0.5", family: 4 },
        { address: "169.254.169.254", family: 4 }
      ]
    });
    await expectCode(
      mixed("https://provider.example.test/v1/models"),
      "provider_http_address_forbidden"
    );
    expect(mixedDispatch).not.toHaveBeenCalled();

    const lookupHostname = vi.fn(async () => [PUBLIC_ADDRESS]);
    const redirectDispatch = vi.fn(async () =>
      new Response(null, {
        headers: { location: "https://provider.example.test/v1/next" },
        status: 307
      })
    );
    const redirects = createProviderSafeFetch({
      configuration: {
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1"
      },
      dispatch: redirectDispatch,
      lookupHostname
    });

    await expectCode(
      redirects("https://provider.example.test/v1/models"),
      "provider_http_redirect_forbidden"
    );
    expect(redirectDispatch).toHaveBeenCalledOnce();
    expect(lookupHostname).toHaveBeenCalledOnce();
  });

  it("resolves and pins again for every new request", async () => {
    const answers: McpResolvedAddress[][] = [
      [{ address: "93.184.216.34", family: 4 }],
      [{ address: "1.1.1.1", family: 4 }]
    ];
    const pinned: McpResolvedAddress[] = [];
    const safeFetch = createProviderSafeFetch({
      configuration: {
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1"
      },
      dispatch: async (request) => {
        pinned.push(request.address);
        return new Response("ok");
      },
      lookupHostname: async () => answers.shift() ?? []
    });

    await safeFetch("https://provider.example.test/v1/first");
    await safeFetch("https://provider.example.test/v1/second");

    expect(pinned).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "1.1.1.1", family: 4 }
    ]);
  });
});
