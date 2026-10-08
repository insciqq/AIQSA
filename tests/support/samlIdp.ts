import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";

/**
 * A synthetic SAML identity provider for tests: a generated RSA key with a self-signed
 * certificate, responses built from parts, and xml-crypto signatures over the assertion and/or
 * the response. Nothing here is a real IdP's key or data.
 */

const SHA256_WITH_RSA = Buffer.from("300d06092a864886f70d01010b0500", "hex");
const COMMON_NAME = Buffer.from("0603550403", "hex");
const EXCLUSIVE_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const ENVELOPED_SIGNATURE = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

export const SAML_TEST_ALGORITHMS = {
  sha1: { digest: "http://www.w3.org/2000/09/xmldsig#sha1", signature: "http://www.w3.org/2000/09/xmldsig#rsa-sha1" },
  sha256: {
    digest: "http://www.w3.org/2001/04/xmlenc#sha256",
    signature: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
  }
} as const;

function der(tag: number, content: Buffer): Buffer {
  const length = content.length;
  const header = length < 0x80
    ? [tag, length]
    : length < 0x100 ? [tag, 0x81, length] : [tag, 0x82, length >> 8, length & 0xff];
  return Buffer.concat([Buffer.from(header), content]);
}

function sequence(...items: Buffer[]): Buffer {
  return der(0x30, Buffer.concat(items));
}

function distinguishedName(commonName: string): Buffer {
  return sequence(der(0x31, sequence(COMMON_NAME, der(0x0c, Buffer.from(commonName, "utf8")))));
}

function certificateTime(date: Date): Buffer {
  const digits = date.toISOString().slice(0, 19).replace(/[-:T]/gu, "");
  const year = date.getUTCFullYear();
  return year >= 1950 && year < 2050
    ? der(0x17, Buffer.from(`${digits.slice(2)}Z`, "ascii"))
    : der(0x18, Buffer.from(`${digits}Z`, "ascii"));
}

function pem(label: string, body: Buffer): string {
  return `-----BEGIN ${label}-----\n${body.toString("base64").match(/.{1,64}/gu)!.join("\n")}\n-----END ${label}-----`;
}

/** A minimal self-signed X.509 v1 certificate (sha256WithRSAEncryption) for a generated key. */
export function selfSignedCertificate(input: {
  commonName?: string;
  notAfter: Date;
  notBefore: Date;
  privateKey: KeyObject;
  publicKey: KeyObject;
}): string {
  const name = distinguishedName(input.commonName ?? "AIQSA Test IdP");
  const toBeSigned = sequence(
    der(0x02, Buffer.from([0x01])),
    SHA256_WITH_RSA,
    name,
    sequence(certificateTime(input.notBefore), certificateTime(input.notAfter)),
    name,
    input.publicKey.export({ format: "der", type: "spki" })
  );
  const signature = sign("sha256", toBeSigned, input.privateKey);
  return pem("CERTIFICATE", sequence(toBeSigned, SHA256_WITH_RSA, der(0x03, Buffer.concat([Buffer.from([0]), signature]))));
}

export type SamlTestIdp = {
  certificate: string;
  entityId: string;
  privateKey: string;
};

export function createSamlTestIdp(input: {
  entityId?: string;
  modulusLength?: number;
  notAfter?: Date;
  notBefore?: Date;
} = {}): SamlTestIdp {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: input.modulusLength ?? 2048 });
  const now = Date.now();
  return {
    certificate: selfSignedCertificate({
      notAfter: input.notAfter ?? new Date(now + 365 * 86_400_000),
      notBefore: input.notBefore ?? new Date(now - 86_400_000),
      privateKey,
      publicKey
    }),
    entityId: input.entityId ?? "https://idp.example.test/realms/aiqsa",
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function attribute(name: string, value: string | null | undefined): string {
  return value === null || value === undefined ? "" : ` ${name}="${escapeXml(value)}"`;
}

export function samlTestId(): string {
  return `_${randomBytes(16).toString("hex")}`;
}

export type SamlTestAssertionInput = {
  acsUrl: string;
  assertionId?: string;
  attributes?: Record<string, string | readonly string[]>;
  audience: string;
  /** The confirmation's `InResponseTo`; null omits it (an IdP-initiated assertion). */
  inResponseTo: string | null;
  issuer: string;
  nameId?: string;
  nameIdFormat?: string;
  /** `Conditions` and `SubjectConfirmationData` validity; defaults: one minute ago to five minutes ahead. */
  notBefore?: Date;
  notOnOrAfter?: Date;
  recipient?: string;
};

/** One `saml:Assertion` element as the IdP issues it, unsigned. */
export function samlTestAssertion(input: SamlTestAssertionInput): string {
  const now = Date.now();
  const issued = new Date(now).toISOString();
  const notBefore = (input.notBefore ?? new Date(now - 60_000)).toISOString();
  const notOnOrAfter = (input.notOnOrAfter ?? new Date(now + 5 * 60_000)).toISOString();
  const attributes = Object.entries(input.attributes ?? {}).map(([name, values]) =>
    `<saml:Attribute Name="${escapeXml(name)}">${(typeof values === "string" ? [values] : values)
      .map((value) => `<saml:AttributeValue>${escapeXml(value)}</saml:AttributeValue>`).join("")}</saml:Attribute>`).join("");
  return [
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${input.assertionId ?? samlTestId()}" Version="2.0" IssueInstant="${issued}">`,
    `<saml:Issuer>${escapeXml(input.issuer)}</saml:Issuer>`,
    "<saml:Subject>",
    `<saml:NameID Format="${escapeXml(input.nameIdFormat ?? "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent")}">${escapeXml(input.nameId ?? "G-0c7f6a3e-synthetic")}</saml:NameID>`,
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${attribute("InResponseTo", input.inResponseTo)} NotOnOrAfter="${notOnOrAfter}" Recipient="${escapeXml(input.recipient ?? input.acsUrl)}"/></saml:SubjectConfirmation>`,
    "</saml:Subject>",
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${escapeXml(input.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`,
    `<saml:AuthnStatement AuthnInstant="${issued}" SessionIndex="${samlTestId()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`,
    attributes ? `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>` : "",
    "</saml:Assertion>"
  ].join("");
}

export type SamlTestResponseInput = {
  /** Assertions in document order, signed or not. */
  assertions: readonly string[];
  /** The response's `Destination`; null omits it. */
  destination: string | null;
  /** The response's `InResponseTo`; null omits it. */
  inResponseTo: string | null;
  issuer: string;
  statusCode?: string;
};

/** A `samlp:Response` around the given assertions, unsigned. */
export function samlTestResponse(input: SamlTestResponseInput): string {
  return [
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${samlTestId()}" Version="2.0" IssueInstant="${new Date().toISOString()}"${attribute("Destination", input.destination)}${attribute("InResponseTo", input.inResponseTo)}>`,
    `<saml:Issuer>${escapeXml(input.issuer)}</saml:Issuer>`,
    `<samlp:Status><samlp:StatusCode Value="${input.statusCode ?? "urn:oasis:names:tc:SAML:2.0:status:Success"}"/></samlp:Status>`,
    ...input.assertions,
    "</samlp:Response>"
  ].join("");
}

type SigningOptions = { algorithm?: keyof typeof SAML_TEST_ALGORITHMS; idp: Pick<SamlTestIdp, "certificate" | "privateKey"> };

function signedXml(xml: string, element: "Assertion" | "Response", options: SigningOptions): string {
  const algorithm = SAML_TEST_ALGORITHMS[options.algorithm ?? "sha256"];
  const signer = new SignedXml({
    canonicalizationAlgorithm: EXCLUSIVE_C14N,
    privateKey: options.idp.privateKey,
    publicCert: options.idp.certificate,
    signatureAlgorithm: algorithm.signature
  });
  const target = element === "Assertion" ? "//*[local-name(.)='Assertion']" : "/*[local-name(.)='Response']";
  signer.addReference({ digestAlgorithm: algorithm.digest, transforms: [ENVELOPED_SIGNATURE, EXCLUSIVE_C14N], xpath: target });
  signer.computeSignature(xml, { location: { action: "after", reference: `${target}/*[local-name(.)='Issuer']` } });
  return signer.getSignedXml();
}

/** Signs a standalone assertion (enveloped, right after its `Issuer`). */
export function signSamlTestAssertion(assertion: string, options: SigningOptions): string {
  return signedXml(assertion, "Assertion", options);
}

/** Signs the whole response (enveloped, right after its `Issuer`). */
export function signSamlTestResponse(response: string, options: SigningOptions): string {
  return signedXml(response, "Response", options);
}

export function encodeSamlTestResponse(xml: string): string {
  return Buffer.from(xml, "utf8").toString("base64");
}

/** The AuthnRequest id inside an HTTP-Redirect location (`SAMLRequest`, raw DEFLATE). */
export function samlAuthnRequestFromLocation(location: string | URL): { id: string; xml: string } {
  const url = new URL(location);
  const xml = inflateRawSync(Buffer.from(url.searchParams.get("SAMLRequest") ?? "", "base64")).toString("utf8");
  const id = /\sID="([^"]+)"/u.exec(xml)?.[1];
  if (!id) throw new Error("saml_test_request_without_id");
  return { id, xml };
}

/** IdP metadata for the test IdP, as an IdP publishes it. */
export function samlTestIdpMetadata(input: {
  certificates: readonly string[];
  entityId: string;
  ssoUrl: string;
}): string {
  const keys = input.certificates.map((certificate) =>
    `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certificate
      .replace(/-----(?:BEGIN|END) CERTIFICATE-----/gu, "").replace(/\s+/gu, "")}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`).join("");
  return [
    `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${escapeXml(input.entityId)}">`,
    `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" WantAuthnRequestsSigned="false">`,
    keys,
    "<md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>",
    `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${escapeXml(input.ssoUrl)}/post"/>`,
    `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${escapeXml(input.ssoUrl)}"/>`,
    "</md:IDPSSODescriptor>",
    "</md:EntityDescriptor>"
  ].join("");
}
