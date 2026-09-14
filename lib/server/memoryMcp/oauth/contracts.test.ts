import { describe, expect, it } from "vitest";
import {
  decodeAuthorizationRequest,
  decodeClientIdMetadataDocument,
  decodeDynamicClientRegistration,
  registeredRedirectUriMatches,
  decodeRevocationRequest,
  decodeTokenRequest,
  validClientIdentifierUrl,
  validRedirectUri
} from "./contracts";

function authorizationParameters(overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    client_id: "https://client.example/oauth/client.json",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
    redirect_uri: "http://127.0.0.1:49152/oauth/callback",
    resource: "https://aiqsa.example/mcp",
    response_type: "code",
    state: "state-1",
    ...overrides
  });
}

describe("inbound Memory MCP OAuth contracts", () => {
  it("accepts the narrow authorization request and rejects authority expansion", () => {
    expect(decodeAuthorizationRequest(authorizationParameters())).toMatchObject({
      ok: true,
      value: {
        clientId: "https://client.example/oauth/client.json",
        state: "state-1"
      }
    });
    expect(decodeAuthorizationRequest(authorizationParameters({ scope: "" })).ok).toBe(true);
    expect(decodeAuthorizationRequest(authorizationParameters({ scope: "memory:read" })))
      .toEqual({ error: "invalid_scope", ok: false });
    expect(decodeAuthorizationRequest(authorizationParameters({
      code_challenge_method: "plain"
    }))).toEqual({ error: "invalid_request", ok: false });
    expect(decodeAuthorizationRequest(authorizationParameters({ user_id: "other-user" })))
      .toEqual({ error: "invalid_request", ok: false });

    const duplicate = authorizationParameters();
    duplicate.append("redirect_uri", "https://attacker.example/callback");
    expect(decodeAuthorizationRequest(duplicate))
      .toEqual({ error: "invalid_request", ok: false });
  });

  it("separates authorization-code and refresh token request shapes", () => {
    expect(decodeTokenRequest(new URLSearchParams({
      client_id: "client-1",
      code: `aiqsa_mc_${"A".repeat(43)}`,
      code_verifier: "v".repeat(43),
      grant_type: "authorization_code",
      redirect_uri: "http://localhost:49152/callback",
      resource: "https://aiqsa.example/mcp"
    }))).toMatchObject({ ok: true, value: { grantType: "authorization_code" } });
    expect(decodeTokenRequest(new URLSearchParams({
      client_id: "client-1",
      grant_type: "refresh_token",
      refresh_token: `aiqsa_mr_${"A".repeat(43)}`,
      resource: "https://aiqsa.example/mcp"
    }))).toMatchObject({ ok: true, value: { grantType: "refresh_token" } });
    expect(decodeTokenRequest(new URLSearchParams({
      client_id: "client-1",
      grant_type: "client_credentials",
      resource: "https://aiqsa.example/mcp"
    }))).toEqual({ error: "unsupported_grant_type", ok: false });
  });

  it("accepts an RFC-style public-client revocation request only", () => {
    expect(decodeRevocationRequest(new URLSearchParams({
      client_id: "client-1",
      token: `aiqsa_mr_${"A".repeat(43)}`,
      token_type_hint: "refresh_token"
    }))).toMatchObject({ ok: true });
    expect(decodeRevocationRequest(new URLSearchParams({
      client_id: "client-1",
      client_secret: "not-supported",
      token: `aiqsa_mr_${"A".repeat(43)}`
    }))).toEqual({ error: "invalid_request", ok: false });
  });

  it("validates CIMD identity, exact redirects, and public-client credentials", () => {
    const clientId = "https://client.example/oauth/client.json";
    const metadata = {
      client_id: clientId,
      client_name: "Example MCP Client",
      client_uri: "https://different-display.example/app",
      redirect_uris: ["http://127.0.0.1:49152/oauth/callback"],
      token_endpoint_auth_method: "none"
    };
    expect(decodeClientIdMetadataDocument({
      allowLoopbackHttp: false,
      clientId,
      value: metadata
    })).toMatchObject({
      applicationType: "NATIVE",
      clientOrigin: "https://client.example",
      redirectUris: metadata.redirect_uris
    });
    expect(decodeClientIdMetadataDocument({
      allowLoopbackHttp: false,
      clientId,
      value: { ...metadata, client_id: "https://attacker.example/client.json" }
    })).toBeNull();
    expect(decodeClientIdMetadataDocument({
      allowLoopbackHttp: false,
      clientId,
      value: { ...metadata, client_secret: "must-not-be-accepted" }
    })).toBeNull();
  });

  it("requires DCR application type and accepts exact HTTP redirects", () => {
    const native = {
      application_type: "native",
      client_name: "Local CLI",
      redirect_uris: ["http://localhost:49152/oauth/callback"],
      token_endpoint_auth_method: "none"
    };
    expect(decodeDynamicClientRegistration({
      allowLoopbackHttp: false,
      clientId: "aiqsa_dcr_client",
      value: native
    })).toMatchObject({ applicationType: "NATIVE" });
    expect(decodeDynamicClientRegistration({
      allowLoopbackHttp: false,
      clientId: "aiqsa_dcr_client",
      value: { ...native, application_type: undefined }
    })).toBeNull();
    expect(decodeDynamicClientRegistration({
      allowLoopbackHttp: false,
      clientId: "aiqsa_dcr_client",
      value: { ...native, application_type: "web" }
    })).toMatchObject({ applicationType: "WEB" });
    expect(decodeDynamicClientRegistration({
      allowLoopbackHttp: false,
      clientId: "aiqsa_dcr_web",
      value: {
        application_type: "web",
        client_name: "LAN web client",
        client_uri: "http://192.168.1.20/client",
        redirect_uris: ["http://192.168.1.20/oauth/callback"]
      }
    })).toMatchObject({
      applicationType: "WEB",
      clientUri: "http://192.168.1.20/client",
      redirectUris: ["http://192.168.1.20/oauth/callback"]
    });
    expect(decodeDynamicClientRegistration({
      allowLoopbackHttp: false,
      clientId: "aiqsa_dcr_private_scheme",
      value: {
        ...native,
        redirect_uris: ["com.example.client:/oauth/callback"]
      }
    })).toMatchObject({
      applicationType: "NATIVE",
      clientOrigin: "com.example.client:"
    });
    expect(validRedirectUri("com.example.client:/oauth/callback", "NATIVE")).toBe(true);
    expect(validRedirectUri("javascript:alert(1)", "NATIVE")).toBe(false);
    expect(validRedirectUri("http://192.168.1.20/oauth/callback", "WEB")).toBe(true);
    expect(validRedirectUri("http://user@192.168.1.20/oauth/callback", "WEB")).toBe(false);
    expect(validRedirectUri("http://192.168.1.20/oauth/callback#fragment", "WEB")).toBe(false);
  });

  it.each(["NATIVE", "WEB"] as const)(
    "requires an exact non-loopback HTTP redirect for %s clients",
    (applicationType) => {
      const registered = "http://192.168.1.20:8080/oauth/callback";
      expect(registeredRedirectUriMatches({
        applicationType,
        presented: registered,
        registered
      })).toBe(true);
      expect(registeredRedirectUriMatches({
        applicationType,
        presented: "http://192.168.1.20:8081/oauth/callback",
        registered
      })).toBe(false);
      expect(registeredRedirectUriMatches({
        applicationType,
        presented: `${registered}?injected=1`,
        registered
      })).toBe(false);
      expect(registeredRedirectUriMatches({
        applicationType,
        presented: "http://192.168.1.21:8080/oauth/callback",
        registered
      })).toBe(false);
      expect(registeredRedirectUriMatches({
        applicationType,
        presented: "https://192.168.1.20:8080/oauth/callback",
        registered
      })).toBe(false);
    }
  );

  it("infers LAN HTTP clients as web and loopback/custom-scheme clients as native", () => {
    const clientId = "http://client.example/oauth/client.json";
    const base = {
      client_id: clientId,
      client_name: "Inferred client",
      token_endpoint_auth_method: "none"
    };
    expect(decodeClientIdMetadataDocument({
      allowLoopbackHttp: false,
      clientId,
      value: { ...base, redirect_uris: ["http://192.168.1.20/oauth/callback"] }
    })).toMatchObject({ applicationType: "WEB" });
    expect(decodeClientIdMetadataDocument({
      allowLoopbackHttp: false,
      clientId,
      value: { ...base, redirect_uris: ["http://127.0.0.1:43119/oauth/callback"] }
    })).toMatchObject({ applicationType: "NATIVE" });
    expect(decodeClientIdMetadataDocument({
      allowLoopbackHttp: false,
      clientId,
      value: { ...base, redirect_uris: ["https://localhost:43119/oauth/callback"] }
    })).toMatchObject({ applicationType: "NATIVE" });
    expect(decodeClientIdMetadataDocument({
      allowLoopbackHttp: false,
      clientId,
      value: { ...base, redirect_uris: ["com.example.client:/oauth/callback"] }
    })).toMatchObject({ applicationType: "NATIVE" });
  });

  it.each(["127.0.0.1", "[::1]", "localhost"])("varies only the native HTTP loopback port for %s", (hostname) => {
    expect(registeredRedirectUriMatches({
      applicationType: "NATIVE",
      presented: `http://${hostname}:54321/oauth/callback`,
      registered: `http://${hostname}/oauth/callback`
    })).toBe(true);
    expect(registeredRedirectUriMatches({
      applicationType: "NATIVE",
      presented: `http://${hostname}:54321/other`,
      registered: `http://${hostname}/oauth/callback`
    })).toBe(false);
    expect(registeredRedirectUriMatches({
      applicationType: "NATIVE",
      presented: `http://${hostname}:54321/oauth/callback?injected=1`,
      registered: `http://${hostname}/oauth/callback`
    })).toBe(false);
    expect(registeredRedirectUriMatches({
      applicationType: "WEB",
      presented: `http://${hostname}:54321/oauth/callback`,
      registered: `http://${hostname}/oauth/callback`
    })).toBe(false);
    expect(registeredRedirectUriMatches({
      applicationType: "NATIVE",
      presented: `https://${hostname}:54321/oauth/callback`,
      registered: `https://${hostname}/oauth/callback`
    })).toBe(false);
  });

  it.each(["127.0.0.1", "app.localhost", "localhost.example", "localhost."])("never aliases localhost to %s", (hostname) => {
    expect(registeredRedirectUriMatches({
      applicationType: "NATIVE",
      presented: `http://${hostname}:54321/oauth/callback`,
      registered: "http://localhost/oauth/callback"
    })).toBe(false);
  });

  it("allows public HTTP client metadata identifiers without widening loopback", () => {
    expect(validClientIdentifierUrl("https://client.example/client.json", false)).toBe(true);
    expect(validClientIdentifierUrl("http://client.example/client.json", false)).toBe(true);
    expect(validClientIdentifierUrl("http://localhost:3001/client.json", false)).toBe(false);
    expect(validClientIdentifierUrl("http://localhost:3001/client.json", true)).toBe(true);
    expect(validClientIdentifierUrl("ftp://client.example/client.json", true)).toBe(false);
  });
});
