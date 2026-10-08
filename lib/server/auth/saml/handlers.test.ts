// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { samlSignInConfigSchema } from "@/lib/contracts/authSignInMethods";
import { samlServiceProvider } from "@/lib/contracts/samlSignIn";
import {
  createSamlTestIdp,
  encodeSamlTestResponse,
  samlAuthnRequestFromLocation,
  samlTestAssertion,
  samlTestResponse,
  signSamlTestAssertion
} from "@/tests/support/samlIdp";
import { getAuthConfig } from "../config";
import type { ExternalSignInResult } from "../externalIdentity";
import { createFixedWindowLoginRateLimiter } from "../rateLimit";
import { readCookie, SESSION_COOKIE_NAME } from "../session";
import type { ResolvedSignInMethod } from "../signInMethods";
import {
  createSamlAcsHandler,
  createSamlMetadataHandler,
  createSamlStartHandler,
  type SamlSignInCompleter
} from "./handlers";
import { readSamlRelayState } from "./relayState";
import { SAML_RESPONSE_MAX_BYTES } from "./response";
import { createSamlReplayCache, createSamlRequestStore } from "./state";

const BASE_URL = "https://aiqsa.example";
const config = getAuthConfig({
  AIQSA_APP_BASE_URL: BASE_URL,
  AIQSA_AUTH_SESSION_SECRET: "saml-handler-test-secret",
  AIQSA_COOKIE_SECURE: "1",
  AIQSA_TRUST_PROXY_HEADERS: "1",
  AIQSA_TRUSTED_PROXY_COUNT: "1"
});
const idp = createSamlTestIdp();
const serviceProvider = samlServiceProvider(BASE_URL, null);
const SSO_URL = "https://idp.example.test/realms/aiqsa/protocol/saml";
let clientOrdinal = 0;

function samlMethod(overrides: Record<string, unknown> = {}): ResolvedSignInMethod<"saml"> {
  return {
    activeVersion: 4,
    config: samlSignInConfigSchema.parse({
      adminGroups: ["/admins"],
      displayNameAttribute: "displayName",
      groupsAttribute: "groups",
      idpCertificates: [idp.certificate],
      idpEntityId: idp.entityId,
      idpSsoUrl: SSO_URL,
      ...overrides
    }),
    method: "saml",
    secrets: {},
    source: "admin"
  };
}

function setup(input: {
  method?: ResolvedSignInMethod<"saml"> | null;
  result?: ExternalSignInResult;
  startBudget?: number;
  throws?: boolean;
} = {}) {
  const method = input.method === undefined ? samlMethod() : input.method;
  const requests = createSamlRequestStore();
  const recordOutcome = vi.fn(async () => undefined);
  const completeSignIn = vi.fn<SamlSignInCompleter>(async () => {
    if (input.throws) throw new Error("database_unavailable");
    return input.result ?? { sessionId: "saml-session", status: "active", userId: "saml-user" };
  });
  const loginRateLimiter = createFixedWindowLoginRateLimiter();
  const client = `203.0.113.${(clientOrdinal += 1) % 250}`;
  const start = createSamlStartHandler({
    getConfig: () => config,
    rateLimiter: createFixedWindowLoginRateLimiter({ maxAttempts: input.startBudget ?? 50 }),
    requests,
    resolveMethod: async () => method
  });
  const acs = createSamlAcsHandler({
    completeSignIn,
    getConfig: () => config,
    loginRateLimiter,
    recordOutcome,
    replayCache: createSamlReplayCache(),
    requests,
    resolveMethod: async () => method
  });

  async function begin(next = "/c/synthetic-chat") {
    const response = await start(new Request(`${BASE_URL}/api/auth/saml/start?next=${encodeURIComponent(next)}`, {
      headers: { "x-forwarded-for": client }
    }));
    const location = new URL(response.headers.get("location")!);
    const requestId = location.searchParams.has("SAMLRequest") ? samlAuthnRequestFromLocation(location).id : "";
    return { location, relayState: location.searchParams.get("RelayState"), requestId, response };
  }

  function post(fields: Record<string, string> | string, headers: Record<string, string> = {}) {
    return acs(new Request(`${BASE_URL}/saml/acs`, {
      body: typeof fields === "string" ? fields : new URLSearchParams(fields).toString(),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://idp.example.test",
        "x-forwarded-for": client,
        ...headers
      },
      method: "POST"
    }));
  }

  return { begin, completeSignIn, loginRateLimiter, post, recordOutcome, requests };
}

function samlResponse(requestId: string | null, attributes: Record<string, string | string[]> = {
  displayName: "Ada Synthetic",
  email: "ada@example.test",
  groups: ["staff", "/admins"]
}): string {
  const assertion = signSamlTestAssertion(samlTestAssertion({
    acsUrl: serviceProvider.acsUrl,
    attributes,
    audience: serviceProvider.entityId,
    inResponseTo: requestId,
    issuer: idp.entityId
  }), { idp });
  return encodeSamlTestResponse(samlTestResponse({
    assertions: [assertion],
    destination: serviceProvider.acsUrl,
    inResponseTo: requestId,
    issuer: idp.entityId
  }));
}

function loginOutcome(response: Response) {
  const location = new URL(response.headers.get("location")!);
  if (location.searchParams.has("saml")) expect(location.searchParams.get("local")).toBe("1");
  return { next: location.searchParams.get("next"), path: location.pathname, saml: location.searchParams.get("saml") };
}

describe("SAML start", () => {
  it("redirects to the IdP with an unsigned AuthnRequest and keeps the request server-side", async () => {
    const saml = setup();
    const { location, relayState, requestId, response } = await saml.begin("/admin?tab=users");
    const request = samlAuthnRequestFromLocation(location);

    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(`${location.origin}${location.pathname}`).toBe(SSO_URL);
    expect(location.searchParams.has("Signature")).toBe(false);
    expect(request.xml).toContain(`AssertionConsumerServiceURL="${serviceProvider.acsUrl}"`);
    expect(request.xml).toContain(`>${serviceProvider.entityId}</saml:Issuer>`);
    expect(request.xml).toContain("Format=\"urn:oasis:names:tc:SAML:2.0:nameid-format:persistent\"");
    expect(request.xml).not.toContain("RequestedAuthnContext");
    expect(readSamlRelayState(relayState, { now: Date.now(), secret: config.sessionSecret })).toEqual({ requestId });
    expect(saml.requests.take(requestId)).toMatchObject({ activeVersion: 4, nextPath: "/admin?tab=users" });
  });

  it("drops an unsafe destination and refuses when SAML is off, auth is unconfigured or the client is over budget", async () => {
    const saml = setup({ startBudget: 2 });
    const unsafe = await saml.begin("https://evil.example/steal");
    expect(saml.requests.take(unsafe.requestId)).toMatchObject({ nextPath: "/" });

    await saml.begin();
    const limited = await saml.begin();
    expect(loginOutcome(limited.response)).toEqual({ next: null, path: "/login", saml: "failed" });
    expect(limited.response.headers.get("retry-after")).not.toBeNull();

    const off = createSamlStartHandler({
      getConfig: () => config,
      rateLimiter: createFixedWindowLoginRateLimiter(),
      requests: createSamlRequestStore(),
      resolveMethod: async () => null
    });
    expect((await off(new Request(`${BASE_URL}/api/auth/saml/start`))).status).toBe(404);
    const unconfigured = createSamlStartHandler({
      getConfig: () => ({ ...config, configured: false }),
      rateLimiter: createFixedWindowLoginRateLimiter(),
      requests: createSamlRequestStore(),
      resolveMethod: async () => samlMethod()
    });
    expect((await unconfigured(new Request(`${BASE_URL}/api/auth/saml/start`))).status).toBe(503);
  });
});

describe("SAML assertion consumer service", () => {
  it("settles a valid response through the shared seam and continues at the request's destination", async () => {
    const saml = setup();
    const { relayState, requestId } = await saml.begin("/c/synthetic-chat");

    const response = await saml.post({ RelayState: relayState!, SAMLResponse: samlResponse(requestId) });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${BASE_URL}/c/synthetic-chat`);
    expect(readCookie(response.headers.get("set-cookie"), SESSION_COOKIE_NAME)).toEqual(expect.any(String));
    expect(saml.completeSignIn).toHaveBeenCalledWith({
      displayName: "Ada Synthetic",
      email: "ada@example.test",
      emailVerified: false,
      groups: ["staff", "/admins"],
      now: expect.any(Date),
      policy: {
        adminGroups: ["/admins"],
        admission: { allowedGroups: [], kind: "groups" },
        autoCreateUsers: true,
        syncGroups: false,
        trustUnverifiedEmail: false
      },
      provider: "saml",
      session: expect.objectContaining({ expiresAt: expect.any(Date), tokenHash: expect.any(String) }),
      signInMethod: "saml",
      source: idp.entityId,
      subject: "G-0c7f6a3e-synthetic"
    });
    expect(saml.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ activeVersion: 4, method: "saml" }), "accepted");
  });

  it("falls back to / when RelayState is missing, tampered with or names another request", async () => {
    const saml = setup();
    const other = await saml.begin("/c/other-chat");
    const cases = [
      undefined,
      `${other.relayState!.slice(0, -2)}xx`,
      other.relayState!
    ];
    for (const relayState of cases) {
      const { requestId } = await saml.begin("/c/synthetic-chat");
      const response = await saml.post({ ...(relayState === undefined ? {} : { RelayState: relayState }), SAMLResponse: samlResponse(requestId) });
      expect(response.headers.get("location"), String(relayState)).toBe(`${BASE_URL}/`);
      expect(readCookie(response.headers.get("set-cookie"), SESSION_COOKIE_NAME)).toEqual(expect.any(String));
    }
  });

  it("refuses an oversized body before parsing it", async () => {
    const saml = setup();
    const { relayState } = await saml.begin();

    const response = await saml.post({ RelayState: relayState!, SAMLResponse: "A".repeat(SAML_RESPONSE_MAX_BYTES) });

    expect(loginOutcome(response)).toEqual({ next: null, path: "/login", saml: "failed" });
    expect(saml.completeSignIn).not.toHaveBeenCalled();
    expect(saml.recordOutcome).toHaveBeenCalledWith(expect.anything(), "response_too_large");
  });

  it("refuses other content types, duplicated fields and unsolicited responses without settling", async () => {
    const saml = setup();
    const { requestId } = await saml.begin();
    const valid = samlResponse(requestId);
    const field = `SAMLResponse=${encodeURIComponent(valid)}`;

    const json = await saml.post(field, { "content-type": "application/json" });
    expect(loginOutcome(json).saml).toBe("failed");
    const duplicated = await saml.post(`${field}&${field}`);
    expect(loginOutcome(duplicated).saml).toBe("failed");
    expect(saml.recordOutcome).toHaveBeenLastCalledWith(expect.anything(), "response_invalid");
    const unsolicited = await saml.post({ SAMLResponse: samlResponse(null) });
    expect(loginOutcome(unsolicited).saml).toBe("failed");
    expect(saml.recordOutcome).toHaveBeenLastCalledWith(expect.anything(), "unsolicited_response");
    expect(saml.completeSignIn).not.toHaveBeenCalled();

    // None of them reached the request, which still signs in once.
    const accepted = await saml.post(field);
    expect(accepted.headers.get("location")).toBe(`${BASE_URL}/`);
    expect(saml.completeSignIn).toHaveBeenCalledTimes(1);
  });

  it("shows each refusal of the settlement as a readable outcome and keeps the destination", async () => {
    for (const status of ["account_conflict", "email_missing", "not_allowed", "pending", "source_changed"] as const) {
      const saml = setup({ result: { status } });
      const { relayState, requestId } = await saml.begin("/c/synthetic-chat");
      const response = await saml.post({ RelayState: relayState!, SAMLResponse: samlResponse(requestId) });
      expect(loginOutcome(response), status).toEqual({ next: "/c/synthetic-chat", path: "/login", saml: status });
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(saml.recordOutcome).toHaveBeenCalledWith(expect.anything(), status === "pending" ? "accepted" : status);
    }
  });

  it("answers a failed settlement or a disabled method with the generic failure", async () => {
    const failing = setup({ throws: true });
    const { relayState, requestId } = await failing.begin();
    const failed = await failing.post({ RelayState: relayState!, SAMLResponse: samlResponse(requestId) });
    expect(loginOutcome(failed).saml).toBe("failed");
    expect(failing.recordOutcome).toHaveBeenCalledWith(expect.anything(), "sign_in_failed");

    const off = setup({ method: null });
    const disabled = await off.post({ SAMLResponse: samlResponse(null) });
    expect(loginOutcome(disabled).saml).toBe("failed");
    expect(off.recordOutcome).not.toHaveBeenCalled();
  });
});

describe("SAML service provider metadata", () => {
  it("publishes the SP entity id, ACS URL and NameID format without a key", async () => {
    const active = createSamlMetadataHandler({
      getConfig: () => config,
      resolveMethod: async () => samlMethod({ nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified", spEntityId: "urn:aiqsa:sp" })
    });
    const response = await active();
    const xml = await response.text();

    expect(response.headers.get("content-type")).toBe("application/samlmetadata+xml; charset=utf-8");
    expect(xml).toContain("entityID=\"urn:aiqsa:sp\"");
    expect(xml).toContain(`Location="${serviceProvider.acsUrl}"`);
    expect(xml).toContain("urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified");
    expect(xml).not.toContain("KeyDescriptor");

    const defaults = await (await createSamlMetadataHandler({ getConfig: () => config, resolveMethod: async () => null })()).text();
    expect(defaults).toContain(`entityID="${serviceProvider.entityId}"`);
    expect(defaults).toContain("urn:oasis:names:tc:SAML:2.0:nameid-format:persistent");
  });
});

// Requests the store saw are consumed exactly once even when two responses race.
describe("SAML request consumption", () => {
  it("lets only one of two concurrent responses for the same request settle", async () => {
    const saml = setup();
    const { requestId } = await saml.begin();
    const body = samlResponse(requestId);

    const [first, second] = await Promise.all([saml.post({ SAMLResponse: body }), saml.post({ SAMLResponse: body })]);

    expect([loginOutcome(first).saml, loginOutcome(second).saml].sort()).toEqual(["failed", null]);
    expect(saml.completeSignIn).toHaveBeenCalledTimes(1);
    expect(saml.requests.take(requestId)).toBeNull();
  });
});
