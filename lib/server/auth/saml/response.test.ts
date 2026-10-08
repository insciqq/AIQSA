// @vitest-environment node
import { describe, expect, it } from "vitest";
import { samlSignInConfigSchema } from "@/lib/contracts/authSignInMethods";
import { samlServiceProvider } from "@/lib/contracts/samlSignIn";
import {
  createSamlTestIdp,
  encodeSamlTestResponse,
  samlTestAssertion,
  samlTestId,
  samlTestResponse,
  signSamlTestAssertion,
  signSamlTestResponse,
  type SamlTestAssertionInput
} from "@/tests/support/samlIdp";
import { verifySamlResponse } from "./response";
import { createSamlReplayCache, createSamlRequestStore } from "./state";

const serviceProvider = samlServiceProvider("https://aiqsa.example", null);
const idp = createSamlTestIdp();
const strangerIdp = createSamlTestIdp({ entityId: idp.entityId });
const ACTIVE_VERSION = 3;
const TRANSIENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";

type ConfigOverrides = Record<string, unknown>;

function config(overrides: ConfigOverrides = {}) {
  return samlSignInConfigSchema.parse({
    displayNameAttribute: "displayName",
    groupsAttribute: "groups",
    idpCertificates: [idp.certificate],
    idpEntityId: idp.entityId,
    idpSsoUrl: "https://idp.example.test/realms/aiqsa/protocol/saml",
    ...overrides
  });
}

function harness(overrides: ConfigOverrides = {}) {
  const requests = createSamlRequestStore();
  const replayCache = createSamlReplayCache();
  return {
    issue(nextPath = "/chats", activeVersion: number | null = ACTIVE_VERSION) {
      const requestId = samlTestId();
      requests.issue(requestId, {
        activeVersion,
        bindingHash: "0".repeat(64),
        expiresAt: Date.now() + 10 * 60_000,
        issuedAt: new Date().toISOString(),
        nextPath
      });
      return requestId;
    },
    verify(xml: string) {
      return verifySamlResponse({
        activeVersion: ACTIVE_VERSION,
        config: config(overrides),
        encodedResponse: encodeSamlTestResponse(xml),
        now: new Date(),
        replayCache,
        requests,
        serviceProvider
      });
    }
  };
}

function assertionFor(requestId: string | null, overrides: Partial<SamlTestAssertionInput> = {}): string {
  return samlTestAssertion({
    acsUrl: serviceProvider.acsUrl,
    attributes: { displayName: "Ada Synthetic", email: "ada@example.test", groups: ["staff", "/admins"] },
    audience: serviceProvider.entityId,
    inResponseTo: requestId,
    issuer: idp.entityId,
    ...overrides
  });
}

function signedAssertion(
  requestId: string | null,
  overrides: Partial<SamlTestAssertionInput> = {},
  signing: { algorithm?: "sha1" | "sha256"; idp?: typeof idp } = {}
): string {
  return signSamlTestAssertion(assertionFor(requestId, overrides), { algorithm: signing.algorithm, idp: signing.idp ?? idp });
}

function responseFor(
  requestId: string | null,
  assertions: readonly string[],
  overrides: Partial<Parameters<typeof samlTestResponse>[0]> = {}
): string {
  return samlTestResponse({
    assertions,
    destination: serviceProvider.acsUrl,
    inResponseTo: requestId,
    issuer: idp.entityId,
    ...overrides
  });
}

describe("verifySamlResponse", () => {
  it("accepts a signed assertion that answers a pending request and reads only its attributes", async () => {
    const saml = harness();
    const requestId = saml.issue("/c/synthetic-chat");

    const result = await saml.verify(responseFor(requestId, [signedAssertion(requestId)]));

    expect(result).toEqual({
      identity: {
        displayName: "Ada Synthetic",
        email: "ada@example.test",
        groups: ["staff", "/admins"],
        subject: "G-0c7f6a3e-synthetic"
      },
      ok: true,
      request: expect.objectContaining({ activeVersion: ACTIVE_VERSION, nextPath: "/c/synthetic-chat" }),
      requestId
    });
  });

  it("accepts a signed response around an unsigned assertion when only the response signature is required", async () => {
    const saml = harness({ requireSignedAssertion: false, requireSignedResponse: true });
    const requestId = saml.issue();

    const result = await saml.verify(signSamlTestResponse(responseFor(requestId, [assertionFor(requestId)]), { idp }));

    expect(result).toMatchObject({ ok: true, requestId });
  });

  it("refuses an unsigned assertion when signed assertions are required, even inside a signed response", async () => {
    const saml = harness({ requireSignedAssertion: true, requireSignedResponse: false });
    const requestId = saml.issue();

    await expect(saml.verify(signSamlTestResponse(responseFor(requestId, [assertionFor(requestId)]), { idp })))
      .resolves.toMatchObject({ code: "signature_invalid", ok: false });
  });

  it("refuses an unsigned response when signed responses are required, even with a signed assertion", async () => {
    const saml = harness({ requireSignedAssertion: false, requireSignedResponse: true });
    const requestId = saml.issue();

    await expect(saml.verify(responseFor(requestId, [signedAssertion(requestId)])))
      .resolves.toMatchObject({ code: "signature_invalid", ok: false });
  });

  it("refuses a response without any signature", async () => {
    const saml = harness();
    const requestId = saml.issue();

    await expect(saml.verify(responseFor(requestId, [assertionFor(requestId)])))
      .resolves.toMatchObject({ code: "signature_invalid", ok: false });
  });

  it("refuses an attribute modified after signing", async () => {
    const saml = harness();
    const requestId = saml.issue();
    const tampered = signedAssertion(requestId).replace("ada@example.test", "mallory@example.test");

    await expect(saml.verify(responseFor(requestId, [tampered])))
      .resolves.toMatchObject({ code: "signature_invalid", ok: false });
  });

  it("reads values from the signed content, so a comment added after signing cannot truncate them", async () => {
    const saml = harness();
    const requestId = saml.issue();
    const commented = signedAssertion(requestId, { attributes: { email: "ada@example.test.attacker.example" } })
      .replace("ada@example.test.attacker.example", "ada@example.test<!---->.attacker.example");

    await expect(saml.verify(responseFor(requestId, [commented])))
      .resolves.toMatchObject({ identity: { email: "ada@example.test.attacker.example" }, ok: true });
  });

  it("refuses a signature-wrapping response with an extra unsigned assertion beside the signed one", async () => {
    const saml = harness();

    for (const forgedFirst of [true, false]) {
      const requestId = saml.issue();
      const forged = assertionFor(requestId, { attributes: { email: "mallory@example.test" }, nameId: "victim-subject" });
      const genuine = signedAssertion(requestId);
      await expect(saml.verify(responseFor(requestId, forgedFirst ? [forged, genuine] : [genuine, forged])))
        .resolves.toMatchObject({ code: "signature_invalid", ok: false });
    }
  });

  it("refuses a signature-wrapping response that hides the signed assertion inside an unsigned one", async () => {
    const saml = harness();
    const requestId = saml.issue();
    const genuine = signedAssertion(requestId);
    const signature = /<(?:ds:)?Signature[\s>][\s\S]*<\/(?:ds:)?Signature>/u.exec(genuine)?.[0] ?? "";
    expect(signature).not.toBe("");
    const forged = assertionFor(requestId, { attributes: { email: "mallory@example.test" }, nameId: "victim-subject" })
      .replace("</saml:Issuer>", `</saml:Issuer>${signature}<saml:Advice>${genuine}</saml:Advice>`);

    await expect(saml.verify(responseFor(requestId, [forged])))
      .resolves.toMatchObject({ code: "signature_invalid", ok: false });
  });

  it("refuses a response signed by a key that is not pinned, and accepts the second pinned certificate", async () => {
    const saml = harness();
    const refusedRequest = saml.issue();
    await expect(saml.verify(responseFor(refusedRequest, [signedAssertion(refusedRequest, {}, { idp: strangerIdp })])))
      .resolves.toMatchObject({ code: "signature_invalid", ok: false });

    const rotated = harness({ idpCertificates: [strangerIdp.certificate, idp.certificate] });
    const rotatedRequest = rotated.issue();
    await expect(rotated.verify(responseFor(rotatedRequest, [signedAssertion(rotatedRequest)])))
      .resolves.toMatchObject({ ok: true });
  });

  it("refuses a wrong audience, destination, recipient or issuer", async () => {
    const saml = harness();
    const cases: [string, (requestId: string) => string][] = [
      ["audience_mismatch", (id) => responseFor(id, [signedAssertion(id, { audience: "https://other.example/saml/metadata" })])],
      ["destination_mismatch", (id) => responseFor(id, [signedAssertion(id)], { destination: "https://other.example/saml/acs" })],
      ["destination_mismatch", (id) => responseFor(id, [signedAssertion(id)], { destination: null })],
      ["recipient_mismatch", (id) => responseFor(id, [signedAssertion(id, { recipient: "https://other.example/saml/acs" })])],
      ["issuer_mismatch", (id) => responseFor(id, [signedAssertion(id, { issuer: "https://other-idp.example.test" })])],
      ["issuer_mismatch", (id) => responseFor(id, [signedAssertion(id)], { issuer: "https://other-idp.example.test" })]
    ];
    for (const [code, build] of cases) {
      const requestId = saml.issue();
      await expect(saml.verify(build(requestId)), code).resolves.toMatchObject({ code, ok: false });
    }
  });

  it("refuses a wrong or unknown InResponseTo", async () => {
    const saml = harness();
    const requestId = saml.issue();
    const otherRequest = saml.issue();
    await expect(saml.verify(responseFor(requestId, [signedAssertion(otherRequest)])))
      .resolves.toMatchObject({ code: "in_response_to_mismatch", ok: false });

    const unknown = samlTestId();
    await expect(saml.verify(responseFor(unknown, [signedAssertion(unknown)])))
      .resolves.toEqual({ code: "request_unknown", ok: false, request: null });
  });

  it("refuses a request issued under another configuration version", async () => {
    const saml = harness();
    const requestId = saml.issue("/", ACTIVE_VERSION - 1);

    await expect(saml.verify(responseFor(requestId, [signedAssertion(requestId)])))
      .resolves.toMatchObject({ code: "request_unknown", ok: false });
  });

  it("consumes the request once, so a replayed response is refused", async () => {
    const saml = harness();
    const requestId = saml.issue();
    const response = responseFor(requestId, [signedAssertion(requestId)]);

    await expect(saml.verify(response)).resolves.toMatchObject({ ok: true });
    await expect(saml.verify(response)).resolves.toMatchObject({ code: "request_unknown", ok: false });
  });

  it("refuses an assertion id it already accepted, until the assertion expires", async () => {
    const saml = harness();
    const assertionId = samlTestId();
    const first = saml.issue();
    await expect(saml.verify(responseFor(first, [signedAssertion(first, { assertionId })]))).resolves.toMatchObject({ ok: true });

    const second = saml.issue();
    await expect(saml.verify(responseFor(second, [signedAssertion(second, { assertionId })])))
      .resolves.toMatchObject({ code: "assertion_replayed", ok: false });
  });

  it("refuses an expired or not yet valid assertion and tolerates 60 seconds of clock skew", async () => {
    const saml = harness();
    const now = Date.now();
    const expired = saml.issue();
    await expect(saml.verify(responseFor(expired, [signedAssertion(expired, { notOnOrAfter: new Date(now - 2 * 60_000) })])))
      .resolves.toMatchObject({ code: "assertion_expired", ok: false });

    const early = saml.issue();
    await expect(saml.verify(responseFor(early, [signedAssertion(early, { notBefore: new Date(now + 2 * 60_000) })])))
      .resolves.toMatchObject({ code: "assertion_expired", ok: false });

    const skewed = saml.issue();
    await expect(saml.verify(responseFor(skewed, [signedAssertion(skewed, {
      notBefore: new Date(now + 30_000),
      notOnOrAfter: new Date(now - 30_000)
    })]))).resolves.toMatchObject({ ok: true });
  });

  it("refuses a SHA-1 signature unless SHA-1 is explicitly allowed", async () => {
    const saml = harness();
    const requestId = saml.issue();
    await expect(saml.verify(responseFor(requestId, [signedAssertion(requestId, {}, { algorithm: "sha1" })])))
      .resolves.toMatchObject({ code: "sha1_refused", ok: false });

    const legacy = harness({ allowSha1: true });
    const legacyRequest = legacy.issue();
    await expect(legacy.verify(responseFor(legacyRequest, [signedAssertion(legacyRequest, {}, { algorithm: "sha1" })])))
      .resolves.toMatchObject({ ok: true });
  });

  it("refuses an unknown or HMAC signature algorithm", async () => {
    const saml = harness();
    const requestId = saml.issue();
    const hmac = signedAssertion(requestId).replace(
      "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      "http://www.w3.org/2000/09/xmldsig#hmac-sha1"
    );

    await expect(saml.verify(responseFor(requestId, [hmac])))
      .resolves.toMatchObject({ code: "signature_invalid", ok: false });
  });

  it("refuses IdP-initiated responses, also when a signed unsolicited assertion is wrapped to name a pending request", async () => {
    const saml = harness();
    const unsolicited = signedAssertion(null);
    await expect(saml.verify(responseFor(null, [unsolicited])))
      .resolves.toEqual({ code: "unsolicited_response", ok: false, request: null });

    const requestId = saml.issue();
    await expect(saml.verify(responseFor(requestId, [unsolicited])))
      .resolves.toMatchObject({ code: "unsolicited_response", ok: false });
  });

  it("refuses an error status from the IdP", async () => {
    const saml = harness();
    const requestId = saml.issue();

    await expect(saml.verify(responseFor(requestId, [], { statusCode: "urn:oasis:names:tc:SAML:2.0:status:Requester" })))
      .resolves.toMatchObject({ code: "idp_status_error", ok: false });
  });

  it("refuses document types, malformed XML, other documents and encrypted assertions without parsing them further", async () => {
    const saml = harness();
    const requestId = saml.issue();
    const doctype = `<!DOCTYPE r [<!ENTITY x "x">]>${responseFor(requestId, [signedAssertion(requestId)])}`;
    await expect(saml.verify(doctype)).resolves.toMatchObject({ code: "response_invalid", ok: false });
    await expect(saml.verify("<samlp:Response")).resolves.toMatchObject({ code: "response_invalid", ok: false });
    await expect(saml.verify(signedAssertion(requestId))).resolves.toMatchObject({ code: "response_invalid", ok: false });

    const encrypted = saml.issue();
    await expect(saml.verify(responseFor(encrypted, ["<saml:EncryptedAssertion><xenc:EncryptedData xmlns:xenc=\"http://www.w3.org/2001/04/xmlenc#\"/></saml:EncryptedAssertion>"])))
      .resolves.toMatchObject({ code: "response_invalid", ok: false });
  });

  it("refuses a transient NameID as the subject and uses the subject attribute when one is configured", async () => {
    const transient = harness();
    const refused = transient.issue();
    await expect(transient.verify(responseFor(refused, [signedAssertion(refused, { nameIdFormat: TRANSIENT })])))
      .resolves.toMatchObject({ code: "subject_transient", ok: false });

    const byAttribute = harness({ subjectAttribute: "uid" });
    const requestId = byAttribute.issue();
    const result = await byAttribute.verify(responseFor(requestId, [signedAssertion(requestId, {
      attributes: { email: "ada@example.test", uid: "ada-synthetic" },
      nameIdFormat: TRANSIENT
    })]));
    expect(result).toMatchObject({ identity: { groups: null, subject: "ada-synthetic" }, ok: true });
  });

  it("reports a missing groups attribute as null, keeps group values exact and bounds their number", async () => {
    const saml = harness();
    const missing = saml.issue();
    await expect(saml.verify(responseFor(missing, [signedAssertion(missing, { attributes: { email: "ada@example.test" } })])))
      .resolves.toMatchObject({ identity: { displayName: "", groups: null }, ok: true });

    const exact = saml.issue();
    await expect(saml.verify(responseFor(exact, [signedAssertion(exact, { attributes: { groups: [" Team Leads ", "/staff"] } })])))
      .resolves.toMatchObject({ identity: { email: null, groups: [" Team Leads ", "/staff"] }, ok: true });

    // Keycloak's group list sends one Attribute element per group, with typed values.
    const repeated = saml.issue();
    await expect(saml.verify(responseFor(repeated, [signedAssertion(repeated, {
      attributeElements: [["groups", ["engineers"]], ["groups", ["admins"]]]
    })]))).resolves.toMatchObject({ identity: { groups: ["staff", "/admins", "engineers", "admins"] }, ok: true });

    const flood = saml.issue();
    const groups = Array.from({ length: 1_001 }, (_, index) => `g${index}`);
    await expect(saml.verify(responseFor(flood, [signedAssertion(flood, { attributes: { groups } })])))
      .resolves.toMatchObject({ code: "groups_invalid", ok: false });
  });
});
