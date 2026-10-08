import { SAML, SamlStatusError, type CacheProvider, type Profile } from "@node-saml/node-saml";
import { SAML_NAME_ID_FORMATS, type SamlServiceProvider } from "@/lib/contracts/samlSignIn";
import { SAML_CLOCK_SKEW_MS, type SamlSignInConfig } from "./config";
import { samlNodeOptions } from "./options";
import type { SamlPendingRequest, SamlReplayCache, SamlRequestStore } from "./state";
import {
  childElements,
  elementsByLocalName,
  parseSamlXml,
  SAML_ASSERTION_NAMESPACE,
  SAML_PROTOCOL_NAMESPACE
} from "./xml";

/** The ACS form body (`SAMLResponse` and `RelayState`), read before anything is parsed. */
export const SAML_RESPONSE_MAX_BYTES = 256 * 1024;
/** What 256 KiB of base64 decodes to. */
const RESPONSE_XML_MAX_LENGTH = 192 * 1024;
const BASE64 = /^[A-Za-z0-9+/=\s]+$/u;
const ID_MAX_LENGTH = 256;
const SUBJECT_MAX_LENGTH = 512;
const GROUP_VALUES_MAX = 1_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";

/** Algorithms accepted in `SignatureMethod` and `DigestMethod`; SHA-1 only with `allowSha1`, HMAC never. */
const SIGNATURE_ALGORITHMS = {
  sha1: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
  strong: new Set([
    "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
    "http://www.w3.org/2007/05/xmldsig-more#sha256-rsa-MGF1"
  ])
};
const DIGEST_ALGORITHMS = {
  sha1: "http://www.w3.org/2000/09/xmldsig#sha1",
  strong: new Set(["http://www.w3.org/2001/04/xmlenc#sha256", "http://www.w3.org/2001/04/xmlenc#sha512"])
};

/** Content-free reasons a response is refused; the method's health line shows them. */
export type SamlResponseFailure =
  | "assertion_expired"
  | "assertion_replayed"
  | "audience_mismatch"
  | "destination_mismatch"
  | "groups_invalid"
  | "idp_status_error"
  | "in_response_to_mismatch"
  | "issuer_mismatch"
  | "recipient_mismatch"
  | "request_unknown"
  | "response_invalid"
  | "sha1_refused"
  | "signature_invalid"
  | "subject_missing"
  | "subject_transient"
  | "unsolicited_response";

export type SamlAssertedIdentity = {
  displayName: string;
  email: string | null;
  /** The groups attribute's values, exact; null when it is not configured or was not sent. */
  groups: string[] | null;
  subject: string;
};

export type SamlResponseVerification =
  | { identity: SamlAssertedIdentity; ok: true; request: SamlPendingRequest; requestId: string }
  | { code: SamlResponseFailure; ok: false; request: SamlPendingRequest | null };

type XmlJsNode = Record<string, unknown>;

function isRecord(value: unknown): value is XmlJsNode {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The child elements `name` of an xml2js node (node-saml parses tags without prefixes). */
function children(node: XmlJsNode | undefined, name: string): XmlJsNode[] {
  const value = node && Object.hasOwn(node, name) ? node[name] : undefined;
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function attributeOf(node: XmlJsNode | undefined, name: string): string | null {
  const attributes = node?.$;
  const value = isRecord(attributes) && Object.hasOwn(attributes, name) ? attributes[name] : undefined;
  return typeof value === "string" ? value : null;
}

function textOf(node: XmlJsNode | undefined): string | null {
  return typeof node?._ === "string" ? node._ : null;
}

function timestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Strict base64 into UTF-8, the same text node-saml decodes from the same field. */
function decodeResponse(encoded: string): string | null {
  if (!encoded || encoded.length > SAML_RESPONSE_MAX_BYTES || !BASE64.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > RESPONSE_XML_MAX_LENGTH) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Every `SignatureMethod` and `DigestMethod` anywhere in the document, in any namespace (the
 * way xml-crypto finds them), must name an accepted algorithm.
 */
function signatureAlgorithmProblem(document: Document, allowSha1: boolean): "sha1_refused" | "signature_invalid" | null {
  let sha1 = false;
  for (const [localName, algorithms] of [["SignatureMethod", SIGNATURE_ALGORITHMS], ["DigestMethod", DIGEST_ALGORITHMS]] as const) {
    for (const element of elementsByLocalName(document, localName)) {
      const algorithm = element.getAttribute("Algorithm") ?? "";
      if (algorithms.strong.has(algorithm)) continue;
      if (algorithm !== algorithms.sha1) return "signature_invalid";
      sha1 = true;
    }
  }
  return sha1 && !allowSha1 ? "sha1_refused" : null;
}

function responseStatus(response: Element): string | null {
  const status = childElements(response, SAML_PROTOCOL_NAMESPACE, "Status")[0];
  const code = status ? childElements(status, SAML_PROTOCOL_NAMESPACE, "StatusCode")[0] : undefined;
  return code?.getAttribute("Value") ?? null;
}

/** node-saml's request cache for one validation: it knows only the request already taken. */
function consumedRequestCache(requestId: string, issuedAt: string): CacheProvider {
  return {
    getAsync: async (key) => (key === requestId ? issuedAt : null),
    removeAsync: async (key) => (key === requestId ? key : null),
    saveAsync: async () => null
  };
}

/** node-saml reports refusals only as messages; they map to codes and are never shown. */
function nodeSamlFailure(error: unknown): SamlResponseFailure {
  if (error instanceof SamlStatusError) return "idp_status_error";
  const message = error instanceof Error ? error.message : "";
  if (/audience/iu.test(message)) return "audience_mismatch";
  if (/expired|not yet valid|subject confirmation/iu.test(message)) return "assertion_expired";
  if (/InResponseTo/iu.test(message)) return "in_response_to_mismatch";
  if (/signature|signed|multiple assertions/iu.test(message)) return "signature_invalid";
  return "response_invalid";
}

/**
 * What node-saml leaves to the caller, read from the assertion it validated (signed content):
 * the issuer, an authentication statement, and a bearer confirmation for this ACS that answers
 * this request and is still live (SAML Web SSO profile 4.1.4.2). The signed `InResponseTo`
 * is required: a signed IdP-initiated assertion wrapped in a response naming a pending request
 * is still unsolicited.
 */
function checkValidatedAssertion(
  profile: Profile,
  input: { config: SamlSignInConfig; now: number; requestId: string; serviceProvider: SamlServiceProvider }
): { assertionId: string; expiresAt: number; ok: true } | { code: SamlResponseFailure; ok: false } {
  // The root of xml2js's document is the element itself; only children come as arrays.
  const document = profile.getAssertion?.();
  const assertion = isRecord(document) && isRecord(document.Assertion) ? document.Assertion : undefined;
  const assertionId = attributeOf(assertion, "ID");
  if (!assertion || !assertionId || assertionId.length > ID_MAX_LENGTH || !children(assertion, "AuthnStatement").length) {
    return { code: "response_invalid", ok: false };
  }
  if (textOf(children(assertion, "Issuer")[0]) !== input.config.idpEntityId) return { code: "issuer_mismatch", ok: false };

  let failure: SamlResponseFailure = "unsolicited_response";
  for (const confirmation of children(children(assertion, "Subject")[0], "SubjectConfirmation")) {
    if (attributeOf(confirmation, "Method") !== BEARER) continue;
    const data = children(confirmation, "SubjectConfirmationData")[0];
    const inResponseTo = attributeOf(data, "InResponseTo");
    if (attributeOf(data, "Recipient") !== input.serviceProvider.acsUrl) {
      failure = "recipient_mismatch";
      continue;
    }
    if (inResponseTo !== input.requestId) {
      failure = inResponseTo === null ? "unsolicited_response" : "in_response_to_mismatch";
      continue;
    }
    const notOnOrAfter = timestamp(attributeOf(data, "NotOnOrAfter"));
    const notBeforeText = attributeOf(data, "NotBefore");
    const notBefore = timestamp(notBeforeText);
    if (
      notOnOrAfter === null ||
      input.now - SAML_CLOCK_SKEW_MS >= notOnOrAfter ||
      (notBeforeText !== null && (notBefore === null || input.now + SAML_CLOCK_SKEW_MS < notBefore))
    ) {
      failure = "assertion_expired";
      continue;
    }
    const conditionsNotOnOrAfter = timestamp(attributeOf(children(assertion, "Conditions")[0], "NotOnOrAfter"));
    return {
      assertionId,
      expiresAt: Math.max(notOnOrAfter, conditionsNotOnOrAfter ?? 0) + SAML_CLOCK_SKEW_MS,
      ok: true
    };
  }
  return { code: failure, ok: false };
}

/** The identity the validated assertion asserts; attributes come only from node-saml's profile. */
function assertedIdentity(
  profile: Profile,
  config: SamlSignInConfig
): { identity: SamlAssertedIdentity; ok: true } | { code: SamlResponseFailure; ok: false } {
  const attributes = isRecord(profile.attributes) ? profile.attributes : {};
  const values = (name: string | null): string[] | null => {
    if (!name || !Object.hasOwn(attributes, name)) return null;
    const value = attributes[name];
    return (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string");
  };
  const first = (name: string | null) => values(name)?.find((value) => value.trim())?.trim() ?? null;

  // A transient NameID changes with every sign-in, so it can never find the account again.
  if (!config.subjectAttribute && profile.nameIDFormat === SAML_NAME_ID_FORMATS.transient) {
    return { code: "subject_transient", ok: false };
  }
  const subject = config.subjectAttribute
    ? first(config.subjectAttribute)
    : typeof profile.nameID === "string" ? profile.nameID.trim() : null;
  if (!subject || subject.length > SUBJECT_MAX_LENGTH || CONTROL_CHARACTERS.test(subject)) {
    return { code: "subject_missing", ok: false };
  }
  const groups = config.groupsAttribute ? values(config.groupsAttribute) : null;
  if (groups && groups.length > GROUP_VALUES_MAX) return { code: "groups_invalid", ok: false };

  return {
    identity: {
      displayName: (first(config.displayNameAttribute) ?? "").slice(0, 160),
      email: first(config.emailAttribute),
      groups,
      subject
    },
    ok: true
  };
}

/**
 * Validates one `SAMLResponse` for the active configuration. The response must answer a pending
 * request, which it consumes before any signature work; node-saml then checks signatures with
 * the pinned certificates, audience, timestamps and `InResponseTo`; the rest is checked here.
 * Nothing about the response leaves this function except a content-free code or the identity.
 */
export async function verifySamlResponse(input: {
  activeVersion: number | null;
  config: SamlSignInConfig;
  encodedResponse: string;
  now: Date;
  replayCache: SamlReplayCache;
  requests: SamlRequestStore;
  serviceProvider: SamlServiceProvider;
}): Promise<SamlResponseVerification> {
  const { config, serviceProvider } = input;
  let request: SamlPendingRequest | null = null;
  const refused = (code: SamlResponseFailure): SamlResponseVerification => ({ code, ok: false, request });

  const xml = decodeResponse(input.encodedResponse);
  let document: Document;
  try {
    if (xml === null) return refused("response_invalid");
    document = parseSamlXml(xml, RESPONSE_XML_MAX_LENGTH);
  } catch {
    return refused("response_invalid");
  }
  const response = document.documentElement;
  if (response.localName !== "Response" || response.namespaceURI !== SAML_PROTOCOL_NAMESPACE) {
    return refused("response_invalid");
  }

  // A response that answers no request (IdP-initiated SSO) is refused before anything else.
  const requestId = response.getAttribute("InResponseTo") ?? "";
  if (!requestId) return refused("unsolicited_response");
  if (requestId.length > ID_MAX_LENGTH) return refused("request_unknown");
  const pending = input.requests.take(requestId);
  if (!pending || pending.activeVersion !== input.activeVersion) return refused("request_unknown");
  request = pending;

  const algorithmProblem = signatureAlgorithmProblem(document, config.allowSha1);
  if (algorithmProblem) return refused(algorithmProblem);
  if (responseStatus(response) !== STATUS_SUCCESS) return refused("idp_status_error");
  if (response.getAttribute("Destination") !== serviceProvider.acsUrl) return refused("destination_mismatch");
  if (childElements(response, SAML_ASSERTION_NAMESPACE, "Issuer").some((issuer) => issuer.textContent !== config.idpEntityId)) {
    return refused("issuer_mismatch");
  }

  let profile: Profile;
  try {
    const saml = new SAML(samlNodeOptions({
      cacheProvider: consumedRequestCache(requestId, pending.issuedAt),
      config,
      serviceProvider
    }));
    const result = await saml.validatePostResponseAsync({ SAMLResponse: input.encodedResponse });
    if (!result.profile || result.loggedOut) return refused("response_invalid");
    profile = result.profile;
  } catch (error) {
    return refused(nodeSamlFailure(error));
  }

  const assertion = checkValidatedAssertion(profile, { config, now: input.now.getTime(), requestId, serviceProvider });
  if (!assertion.ok) return refused(assertion.code);
  if (!input.replayCache.remember(`${config.idpEntityId}\0${assertion.assertionId}`, assertion.expiresAt)) {
    return refused("assertion_replayed");
  }
  const asserted = assertedIdentity(profile, config);
  return asserted.ok ? { identity: asserted.identity, ok: true, request: pending, requestId } : refused(asserted.code);
}
