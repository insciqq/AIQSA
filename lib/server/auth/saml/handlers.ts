import { generateServiceProviderMetadata, SAML } from "@node-saml/node-saml";
import type { AuthSessionSignInMethod } from "@/lib/contracts/authSignInMethods";
import {
  SAML_COMPLETE_PATH,
  SAML_NAME_ID_FORMATS,
  samlServiceProvider,
  type SamlLoginOutcome
} from "@/lib/contracts/samlSignIn";
import { safeInternalPath } from "../../../auth/internalPath";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "../../http/requestBody";
import { resolveLoginRateLimitIdentity } from "../clientIdentity";
import type { AuthConfig } from "../config";
import {
  externalIdentityPolicy,
  type ExternalIdentityInput,
  type ExternalSignInResult
} from "../externalIdentity";
import type { LoginRateLimiter } from "../rateLimit";
import { prepareAuthSession } from "../requestAuth";
import type { SignInSessionInput } from "../signInCompletion";
import type { ResolvedSignInMethod } from "../signInMethods";
import type { SignInHealthRecorder } from "../signInSettings/health";
import {
  clearSamlBrowserBindingCookie,
  createSamlBrowserBinding,
  readSamlBrowserBinding,
  samlBindingMatches
} from "./binding";
import { samlIdentitySource } from "./config";
import { samlNodeOptions } from "./options";
import { createSamlRequestId, readSamlRelayState, signSamlRelayState } from "./relayState";
import { SAML_RESPONSE_MAX_BYTES, verifySamlResponse } from "./response";
import {
  SAML_COMPLETION_TTL_MS,
  SAML_REQUEST_TTL_MS,
  type SamlCompletionStore,
  type SamlReplayCache,
  type SamlRequestStore
} from "./state";

export type SamlMethodResolver = () => Promise<ResolvedSignInMethod<"saml"> | null>;

export type SamlSignInCompleter = (
  input: ExternalIdentityInput & { session: SignInSessionInput; signInMethod: AuthSessionSignInMethod }
) => Promise<ExternalSignInResult>;

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    location,
    "referrer-policy": "no-referrer"
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { headers, status: 303 });
}

/**
 * `/login?saml=<outcome>`, keeping a destination other than the default. `local=1` keeps an
 * OIDC auto-redirect from leaving before the person reads the outcome.
 */
function outcomeRedirect(
  config: AuthConfig,
  outcome: SamlLoginOutcome,
  input: { cookies?: string[]; nextPath?: string; retryAfterSeconds?: number } = {}
): Response {
  const url = new URL("/login", config.appBaseUrl);
  url.searchParams.set("saml", outcome);
  url.searchParams.set("local", "1");
  if (input.nextPath && input.nextPath !== "/") url.searchParams.set("next", input.nextPath);
  const response = redirect(url.toString(), input.cookies);
  if (input.retryAfterSeconds !== undefined) response.headers.set("retry-after", String(input.retryAfterSeconds));
  return response;
}

/**
 * `GET /api/auth/saml/start?next=…`: an unsigned AuthnRequest over HTTP-Redirect. The request
 * waits server-side with the destination (single replica) and the hash of a nonce whose `Lax`
 * binding cookie this browser receives; `RelayState` names the request under an HMAC.
 */
export function createSamlStartHandler(deps: {
  createRequestId?: () => string;
  getConfig(): AuthConfig;
  now?: () => Date;
  /** Per-client budget: each start holds server memory until it is answered or expires. */
  rateLimiter: LoginRateLimiter;
  requests: SamlRequestStore;
  resolveMethod: SamlMethodResolver;
}) {
  return async function GET(request: Request): Promise<Response> {
    const config = deps.getConfig();
    if (!config.configured) return Response.json({ error: "auth_not_configured" }, { status: 503 });
    const method = await deps.resolveMethod();
    if (!method) return Response.json({ error: "not_found" }, { status: 404 });

    const client = resolveLoginRateLimitIdentity(request, config);
    if (client.status === "unavailable") return outcomeRedirect(config, "failed");
    if (client.status === "available") {
      const decision = await deps.rateLimiter.check(`saml-start:client:${client.key}`);
      if (!decision.allowed) return outcomeRedirect(config, "failed", { retryAfterSeconds: decision.retryAfterSeconds });
    }

    const now = deps.now?.() ?? new Date();
    const nextPath = safeInternalPath(new URL(request.url).searchParams.get("next"), config.appBaseUrl);
    const requestId = (deps.createRequestId ?? createSamlRequestId)();
    const expiresAt = now.getTime() + SAML_REQUEST_TTL_MS;
    let issuedAt: string | null = null;
    try {
      const saml = new SAML(samlNodeOptions({
        cacheProvider: {
          getAsync: async () => null,
          removeAsync: async () => null,
          async saveAsync(key, value) {
            if (key === requestId) issuedAt = value;
            return { createdAt: now.getTime(), value };
          }
        },
        config: method.config,
        generateUniqueId: () => requestId,
        serviceProvider: samlServiceProvider(config.appBaseUrl, method.config.spEntityId)
      }));
      const location = await saml.getAuthorizeUrlAsync(
        signSamlRelayState({ expiresAt, requestId, secret: config.sessionSecret }),
        undefined,
        {}
      );
      if (!issuedAt) return outcomeRedirect(config, "failed", { nextPath });
      const binding = createSamlBrowserBinding({
        maxAgeSeconds: SAML_REQUEST_TTL_MS / 1000,
        requestId,
        secret: config.sessionSecret,
        secure: config.cookieSecure
      });
      deps.requests.issue(requestId, {
        activeVersion: method.activeVersion ?? null,
        bindingHash: binding.hash,
        expiresAt,
        issuedAt,
        nextPath
      });
      return redirect(location, [binding.cookie]);
    } catch {
      return outcomeRedirect(config, "failed", { nextPath });
    }
  };
}

type SamlForm = { relayState: string | null; samlResponse: string };

/** The HTTP-POST binding's form, bounded before it is decoded. */
async function readSamlForm(request: Request): Promise<{ form: SamlForm; ok: true } | { code: string; ok: false }> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return { code: "response_invalid", ok: false };
  let text: string;
  try {
    const body = await readBoundedRequestBody(request, { maxBytes: SAML_RESPONSE_MAX_BYTES });
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch (error) {
    return { code: error instanceof RequestBodyTooLargeError ? "response_too_large" : "response_invalid", ok: false };
  }
  const params = new URLSearchParams(text);
  const responses = params.getAll("SAMLResponse");
  const relayStates = params.getAll("RelayState");
  if (responses.length !== 1 || !responses[0] || relayStates.length > 1) return { code: "response_invalid", ok: false };
  return { form: { relayState: relayStates[0] ?? null, samlResponse: responses[0] }, ok: true };
}

/**
 * `POST /saml/acs`, outside `/api`: the IdP's cross-site form POST carries no `Lax` cookies
 * and would fail the `/api` origin guard. The response proves itself (see
 * `verifySamlResponse`), but proves nothing about the browser posting it, so the ACS creates
 * no session: it keeps the validated identity briefly under the request and sends the browser
 * to the completion step, where the binding cookie of the browser that started the sign-in
 * must arrive. The destination is the request's own, or `/` when `RelayState` does not name it.
 */
export function createSamlAcsHandler(deps: {
  completions: SamlCompletionStore;
  getConfig(): AuthConfig;
  loginRateLimiter: LoginRateLimiter;
  now?: () => Date;
  recordOutcome: SignInHealthRecorder;
  replayCache: SamlReplayCache;
  requests: SamlRequestStore;
  resolveMethod: SamlMethodResolver;
}) {
  return async function POST(request: Request): Promise<Response> {
    const config = deps.getConfig();
    if (!config.configured) return Response.json({ error: "not_found" }, { status: 404 });
    const method = await deps.resolveMethod();
    if (!method) return outcomeRedirect(config, "failed");
    const record = (code: string) => deps.recordOutcome(method, code);

    const client = resolveLoginRateLimitIdentity(request, config);
    if (client.status === "unavailable") return outcomeRedirect(config, "failed");
    const rateLimitKey = client.status === "available" ? `saml-acs:client:${client.key}` : null;
    if (rateLimitKey) {
      const decision = await deps.loginRateLimiter.check(rateLimitKey);
      if (!decision.allowed) return outcomeRedirect(config, "failed", { retryAfterSeconds: decision.retryAfterSeconds });
    }

    const read = await readSamlForm(request);
    if (!read.ok) {
      await record(read.code);
      return outcomeRedirect(config, "failed");
    }
    const now = deps.now?.() ?? new Date();
    const verification = await verifySamlResponse({
      activeVersion: method.activeVersion ?? null,
      config: method.config,
      encodedResponse: read.form.samlResponse,
      now,
      replayCache: deps.replayCache,
      requests: deps.requests,
      serviceProvider: samlServiceProvider(config.appBaseUrl, method.config.spEntityId)
    });
    if (!verification.ok) {
      await record(verification.code);
      return outcomeRedirect(config, "failed", { nextPath: verification.request?.nextPath });
    }

    const relayState = readSamlRelayState(read.form.relayState, { now: now.getTime(), secret: config.sessionSecret });
    deps.completions.put(verification.requestId, {
      activeVersion: verification.request.activeVersion,
      bindingHash: verification.request.bindingHash,
      expiresAt: now.getTime() + SAML_COMPLETION_TTL_MS,
      identity: verification.identity,
      nextPath: relayState?.requestId === verification.requestId ? verification.request.nextPath : "/",
      source: samlIdentitySource(method.config)
    });
    // A valid response gives back only its own attempt; earlier failures keep counting.
    if (rateLimitKey) await deps.loginRateLimiter.release(rateLimitKey);
    return redirect(new URL(SAML_COMPLETE_PATH, config.appBaseUrl).toString());
  };
}

/**
 * `GET /api/auth/saml/complete`: the top-level GET the ACS redirects to, which carries the
 * initiating browser's `Lax` binding cookie. Only a cookie whose HMAC holds, naming a stored
 * result whose nonce hash it matches, under the same active configuration, settles the sign-in
 * through the shared seam and issues the session. Everything else, a response replayed into
 * another browser included, ends without a session. The result is single-use either way.
 */
export function createSamlCompleteHandler(deps: {
  completeSignIn: SamlSignInCompleter;
  completions: SamlCompletionStore;
  getConfig(): AuthConfig;
  now?: () => Date;
  recordOutcome: SignInHealthRecorder;
  resolveMethod: SamlMethodResolver;
}) {
  return async function GET(request: Request): Promise<Response> {
    const config = deps.getConfig();
    if (!config.configured) return Response.json({ error: "not_found" }, { status: 404 });
    const cookies = [clearSamlBrowserBindingCookie(config.cookieSecure)];
    const binding = readSamlBrowserBinding(request.headers.get("cookie"), config.sessionSecret);
    const completion = binding ? deps.completions.take(binding.requestId) : null;
    // Not recorded as health: anyone can reach this step, so a mismatch says nothing of the IdP.
    if (!binding || !completion || !samlBindingMatches(binding.nonce, completion.bindingHash)) {
      return outcomeRedirect(config, "browser_mismatch", { cookies });
    }
    const nextPath = safeInternalPath(completion.nextPath, config.appBaseUrl);
    const method = await deps.resolveMethod();
    if (!method) return outcomeRedirect(config, "failed", { cookies, nextPath });
    const record = (code: string) => deps.recordOutcome(method, code);
    if ((method.activeVersion ?? null) !== completion.activeVersion) {
      await record("request_unknown");
      return outcomeRedirect(config, "failed", { cookies, nextPath });
    }

    const now = deps.now?.() ?? new Date();
    const session = prepareAuthSession({ now, request, secureCookie: config.cookieSecure });
    const { identity } = completion;
    let result: ExternalSignInResult;
    try {
      result = await deps.completeSignIn({
        displayName: identity.displayName,
        email: identity.email,
        // SAML asserts no verification of the address; only the method's trust setting links by email.
        emailVerified: false,
        groups: identity.groups,
        now,
        policy: externalIdentityPolicy(method.config),
        provider: "saml",
        session: session.input,
        signInMethod: "saml",
        source: completion.source,
        subject: identity.subject
      });
    } catch {
      await record("sign_in_failed");
      return outcomeRedirect(config, "failed", { cookies, nextPath });
    }

    switch (result.status) {
      case "active":
        await record("accepted");
        return redirect(new URL(nextPath, config.appBaseUrl).toString(), [...cookies, session.cookie]);
      case "pending":
        // A pending account is the IdP working as configured.
        await record("accepted");
        return outcomeRedirect(config, "pending", { cookies, nextPath });
      case "second_factor_required":
        // SAML relies on the IdP's MFA; the completion seam never asks it for a second factor.
        await record("sign_in_failed");
        return outcomeRedirect(config, "failed", { cookies, nextPath });
      default:
        await record(result.status);
        return outcomeRedirect(config, result.status, { cookies, nextPath });
    }
  };
}

/**
 * `GET /saml/metadata`: the SP's entity id, ACS URL and NameID format for the IdP, from the
 * active configuration or the defaults before one is active. No key: requests are unsigned.
 */
export function createSamlMetadataHandler(deps: { getConfig(): AuthConfig; resolveMethod: SamlMethodResolver }) {
  return async function GET(): Promise<Response> {
    const config = deps.getConfig();
    const settings = (await deps.resolveMethod())?.config;
    const serviceProvider = samlServiceProvider(config.appBaseUrl, settings?.spEntityId ?? null);
    const xml = generateServiceProviderMetadata({
      callbackUrl: serviceProvider.acsUrl,
      identifierFormat: settings?.nameIdFormat ?? SAML_NAME_ID_FORMATS.persistent,
      issuer: serviceProvider.entityId,
      wantAssertionsSigned: settings?.requireSignedAssertion ?? true
    });
    return new Response(xml, {
      headers: {
        "cache-control": "no-cache",
        "content-type": "application/samlmetadata+xml; charset=utf-8",
        "x-content-type-options": "nosniff"
      }
    });
  };
}
