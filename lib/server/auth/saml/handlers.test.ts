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
import { readSamlBrowserBinding, SAML_BINDING_COOKIE_NAME, samlBindingMatches } from "./binding";
import {
  createSamlAcsHandler,
  createSamlCompleteHandler,
  createSamlMetadataHandler,
  createSamlStartHandler,
  type SamlSignInCompleter
} from "./handlers";
import { readSamlRelayState } from "./relayState";
import { SAML_RESPONSE_MAX_BYTES } from "./response";
import { createSamlCompletionStore, createSamlReplayCache, createSamlRequestStore, SAML_COMPLETION_TTL_MS } from "./state";

const BASE_URL = "https://aiqsa.example";
const COMPLETE_URL = `${BASE_URL}/api/auth/saml/complete`;
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

function samlMethod(overrides: Record<string, unknown> = {}, activeVersion = 4): ResolvedSignInMethod<"saml"> {
  return {
    activeVersion,
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
  let method = input.method === undefined ? samlMethod() : input.method;
  let completionClockSkewMs = 0;
  const requests = createSamlRequestStore();
  const completions = createSamlCompletionStore({ now: () => Date.now() + completionClockSkewMs });
  const recordOutcome = vi.fn(async () => undefined);
  const completeSignIn = vi.fn<SamlSignInCompleter>(async () => {
    if (input.throws) throw new Error("database_unavailable");
    return input.result ?? { sessionId: "saml-session", status: "active", userId: "saml-user" };
  });
  const client = `203.0.113.${(clientOrdinal += 1) % 250}`;
  const resolveMethod = async () => method;
  const start = createSamlStartHandler({
    getConfig: () => config,
    rateLimiter: createFixedWindowLoginRateLimiter({ maxAttempts: input.startBudget ?? 50 }),
    requests,
    resolveMethod
  });
  const acs = createSamlAcsHandler({
    completions,
    getConfig: () => config,
    loginRateLimiter: createFixedWindowLoginRateLimiter(),
    recordOutcome,
    replayCache: createSamlReplayCache(),
    requests,
    resolveMethod
  });
  const complete = createSamlCompleteHandler({ completeSignIn, completions, getConfig: () => config, recordOutcome, resolveMethod });

  /** The browser's click on "Continue with SAML": the IdP location and the binding cookie it receives. */
  async function begin(next = "/c/synthetic-chat") {
    const response = await start(new Request(`${BASE_URL}/api/auth/saml/start?next=${encodeURIComponent(next)}`, {
      headers: { "x-forwarded-for": client }
    }));
    const location = new URL(response.headers.get("location")!);
    const requestId = location.searchParams.has("SAMLRequest") ? samlAuthnRequestFromLocation(location).id : "";
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? null;
    return { cookie, location, relayState: location.searchParams.get("RelayState"), requestId, response };
  }

  /** The IdP page's cross-site form POST: no AIQSA cookie travels with it. */
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

  /** The top-level GET the ACS redirects to, with whatever binding cookie this browser holds. */
  function finish(cookie: string | null) {
    return complete(new Request(COMPLETE_URL, { headers: { ...(cookie ? { cookie } : {}), "x-forwarded-for": client } }));
  }

  return {
    advanceCompletionClock(ms: number) {
      completionClockSkewMs += ms;
    },
    begin,
    completeSignIn,
    finish,
    post,
    recordOutcome,
    requests,
    setMethod(next: ResolvedSignInMethod<"saml"> | null) {
      method = next;
    }
  };
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

function sessionCookie(response: Response): string | undefined {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`));
  return cookie ? readCookie(cookie, SESSION_COOKIE_NAME) : undefined;
}

describe("SAML start", () => {
  it("redirects to the IdP with an unsigned AuthnRequest and binds the server-side request to this browser", async () => {
    const saml = setup();
    const { cookie, location, relayState, requestId, response } = await saml.begin("/admin?tab=users");
    const request = samlAuthnRequestFromLocation(location);

    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain("; Path=/api/auth/saml; HttpOnly; SameSite=Lax; Max-Age=600; Secure");
    expect(`${location.origin}${location.pathname}`).toBe(SSO_URL);
    expect(location.searchParams.has("Signature")).toBe(false);
    expect(request.xml).toContain(`AssertionConsumerServiceURL="${serviceProvider.acsUrl}"`);
    expect(request.xml).toContain(`>${serviceProvider.entityId}</saml:Issuer>`);
    expect(request.xml).toContain("Format=\"urn:oasis:names:tc:SAML:2.0:nameid-format:persistent\"");
    expect(request.xml).not.toContain("RequestedAuthnContext");
    expect(readSamlRelayState(relayState, { now: Date.now(), secret: config.sessionSecret })).toEqual({ requestId });

    const binding = readSamlBrowserBinding(cookie, config.sessionSecret);
    const pending = saml.requests.take(requestId);
    expect(binding?.requestId).toBe(requestId);
    expect(pending).toMatchObject({ activeVersion: 4, nextPath: "/admin?tab=users" });
    expect(samlBindingMatches(binding!.nonce, pending!.bindingHash)).toBe(true);
  });

  it("drops an unsafe destination and refuses when SAML is off, auth is unconfigured or the client is over budget", async () => {
    const saml = setup({ startBudget: 2 });
    const unsafe = await saml.begin("https://evil.example/steal");
    expect(saml.requests.take(unsafe.requestId)).toMatchObject({ nextPath: "/" });

    await saml.begin();
    const limited = await saml.begin();
    expect(loginOutcome(limited.response)).toEqual({ next: null, path: "/login", saml: "failed" });
    expect(limited.response.headers.get("retry-after")).not.toBeNull();
    expect(limited.cookie).toBeNull();

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

describe("SAML assertion consumer service and completion", () => {
  it("issues the session only in the completion step of the browser that started the sign-in", async () => {
    const saml = setup();
    const { cookie, relayState, requestId } = await saml.begin("/c/synthetic-chat");

    const accepted = await saml.post({ RelayState: relayState!, SAMLResponse: samlResponse(requestId) });
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe(COMPLETE_URL);
    expect(accepted.headers.get("set-cookie")).toBeNull();
    expect(saml.completeSignIn).not.toHaveBeenCalled();

    const completed = await saml.finish(cookie);
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toBe(`${BASE_URL}/c/synthetic-chat`);
    expect(sessionCookie(completed)).toEqual(expect.any(String));
    expect(completed.headers.get("set-cookie")).toContain(`${SAML_BINDING_COOKIE_NAME}=; Path=/api/auth/saml; HttpOnly; SameSite=Lax; Max-Age=0`);
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

  it("creates no session for a valid response that reaches a browser without the initiating cookie", async () => {
    const saml = setup();
    // The attacker's own flow: their browser holds this cookie, the victim's never does.
    const initiating = await saml.begin("/c/attacker-chat");
    const victimOwnFlow = await saml.begin("/c/victim-chat");
    await saml.post({ RelayState: initiating.relayState!, SAMLResponse: samlResponse(initiating.requestId) });

    const forged = `${initiating.cookie!.slice(0, -2)}${initiating.cookie!.endsWith("AA") ? "BB" : "AA"}`;
    for (const cookie of [null, victimOwnFlow.cookie, forged]) {
      const response = await saml.finish(cookie);
      expect(loginOutcome(response), String(cookie)).toEqual({ next: null, path: "/login", saml: "browser_mismatch" });
      expect(sessionCookie(response)).toBeUndefined();
    }
    expect(saml.completeSignIn).not.toHaveBeenCalled();
    expect(saml.recordOutcome).not.toHaveBeenCalled();

    // Only the browser that started this request turns it into a session.
    const owner = await saml.finish(initiating.cookie);
    expect(owner.headers.get("location")).toBe(`${BASE_URL}/c/attacker-chat`);
    expect(sessionCookie(owner)).toEqual(expect.any(String));
  });

  it("completes once, and not after the validated response expired", async () => {
    const saml = setup();
    const first = await saml.begin();
    await saml.post({ RelayState: first.relayState!, SAMLResponse: samlResponse(first.requestId) });
    expect(sessionCookie(await saml.finish(first.cookie))).toEqual(expect.any(String));
    const again = await saml.finish(first.cookie);
    expect(loginOutcome(again).saml).toBe("browser_mismatch");
    expect(sessionCookie(again)).toBeUndefined();

    const late = await saml.begin();
    await saml.post({ RelayState: late.relayState!, SAMLResponse: samlResponse(late.requestId) });
    saml.advanceCompletionClock(SAML_COMPLETION_TTL_MS + 1_000);
    const expired = await saml.finish(late.cookie);
    expect(loginOutcome(expired).saml).toBe("browser_mismatch");
    expect(sessionCookie(expired)).toBeUndefined();
    expect(saml.completeSignIn).toHaveBeenCalledTimes(1);
  });

  it("ends without a session when another configuration was activated before the completion", async () => {
    const saml = setup();
    const { cookie, relayState, requestId } = await saml.begin("/c/synthetic-chat");
    await saml.post({ RelayState: relayState!, SAMLResponse: samlResponse(requestId) });
    saml.setMethod(samlMethod({}, 5));

    const response = await saml.finish(cookie);

    expect(loginOutcome(response)).toEqual({ next: "/c/synthetic-chat", path: "/login", saml: "failed" });
    expect(sessionCookie(response)).toBeUndefined();
    expect(saml.completeSignIn).not.toHaveBeenCalled();
    expect(saml.recordOutcome).toHaveBeenCalledWith(expect.anything(), "request_unknown");
  });

  it("falls back to / when RelayState is missing, tampered with or names another request", async () => {
    const saml = setup();
    const other = await saml.begin("/c/other-chat");
    for (const relayState of [undefined, `${other.relayState!.slice(0, -2)}xx`, other.relayState!]) {
      const { cookie, requestId } = await saml.begin("/c/synthetic-chat");
      await saml.post({ ...(relayState === undefined ? {} : { RelayState: relayState }), SAMLResponse: samlResponse(requestId) });
      const response = await saml.finish(cookie);
      expect(response.headers.get("location"), String(relayState)).toBe(`${BASE_URL}/`);
      expect(sessionCookie(response)).toEqual(expect.any(String));
    }
  });

  it("refuses an oversized body before parsing it", async () => {
    const saml = setup();
    const { relayState } = await saml.begin();

    const response = await saml.post({ RelayState: relayState!, SAMLResponse: "A".repeat(SAML_RESPONSE_MAX_BYTES) });

    expect(loginOutcome(response)).toEqual({ next: null, path: "/login", saml: "failed" });
    expect(saml.recordOutcome).toHaveBeenCalledWith(expect.anything(), "response_too_large");
  });

  it("refuses other content types, duplicated fields and unsolicited responses without storing anything", async () => {
    const saml = setup();
    const { cookie, requestId } = await saml.begin();
    const field = `SAMLResponse=${encodeURIComponent(samlResponse(requestId))}`;

    const json = await saml.post(field, { "content-type": "application/json" });
    expect(loginOutcome(json).saml).toBe("failed");
    const duplicated = await saml.post(`${field}&${field}`);
    expect(loginOutcome(duplicated).saml).toBe("failed");
    expect(saml.recordOutcome).toHaveBeenLastCalledWith(expect.anything(), "response_invalid");
    const unsolicited = await saml.post({ SAMLResponse: samlResponse(null) });
    expect(loginOutcome(unsolicited).saml).toBe("failed");
    expect(saml.recordOutcome).toHaveBeenLastCalledWith(expect.anything(), "unsolicited_response");
    expect(loginOutcome(await saml.finish(cookie)).saml).toBe("browser_mismatch");

    // None of them reached the request, which still signs in once.
    expect((await saml.post(field)).headers.get("location")).toBe(COMPLETE_URL);
    expect(sessionCookie(await saml.finish(cookie))).toEqual(expect.any(String));
    expect(saml.completeSignIn).toHaveBeenCalledTimes(1);
  });

  it("shows each refusal of the settlement as a readable outcome and keeps the destination", async () => {
    for (const status of ["account_conflict", "email_missing", "not_allowed", "pending", "source_changed"] as const) {
      const saml = setup({ result: { status } });
      const { cookie, relayState, requestId } = await saml.begin("/c/synthetic-chat");
      await saml.post({ RelayState: relayState!, SAMLResponse: samlResponse(requestId) });
      const response = await saml.finish(cookie);
      expect(loginOutcome(response), status).toEqual({ next: "/c/synthetic-chat", path: "/login", saml: status });
      expect(sessionCookie(response)).toBeUndefined();
      expect(saml.recordOutcome).toHaveBeenCalledWith(expect.anything(), status === "pending" ? "accepted" : status);
    }
  });

  it("answers a failed settlement or a disabled method with the generic failure", async () => {
    const failing = setup({ throws: true });
    const { cookie, relayState, requestId } = await failing.begin();
    await failing.post({ RelayState: relayState!, SAMLResponse: samlResponse(requestId) });
    const failed = await failing.finish(cookie);
    expect(loginOutcome(failed).saml).toBe("failed");
    expect(failing.recordOutcome).toHaveBeenCalledWith(expect.anything(), "sign_in_failed");

    const off = setup({ method: null });
    const disabled = await off.post({ SAMLResponse: samlResponse(null) });
    expect(loginOutcome(disabled).saml).toBe("failed");
    expect(off.recordOutcome).not.toHaveBeenCalled();
  });

  it("lets only one of two concurrent responses for the same request through", async () => {
    const saml = setup();
    const { cookie, requestId } = await saml.begin();
    const body = samlResponse(requestId);

    const [first, second] = await Promise.all([saml.post({ SAMLResponse: body }), saml.post({ SAMLResponse: body })]);

    expect([first.headers.get("location"), second.headers.get("location")].filter((location) => location === COMPLETE_URL)).toHaveLength(1);
    expect(sessionCookie(await saml.finish(cookie))).toEqual(expect.any(String));
    expect(saml.completeSignIn).toHaveBeenCalledTimes(1);
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
