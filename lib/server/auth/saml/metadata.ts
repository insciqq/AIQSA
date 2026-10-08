import { X509Certificate } from "node:crypto";
import { SAML_METADATA_XML_MAX_LENGTH } from "@/lib/contracts/samlSignIn";
import {
  childElements,
  elementsByLocalName,
  parseSamlXml,
  SAML_METADATA_NAMESPACE,
  XML_SIGNATURE_NAMESPACE
} from "./xml";

const HTTP_REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const SAML2_PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
const MIN_RSA_MODULUS_BITS = 2_048;
const ENTITY_ID_MAX_LENGTH = 1_024;
const URL_MAX_LENGTH = 2_048;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
/** Query parameters the HTTP-Redirect binding adds; an SSO URL carrying them cannot take a request. */
const BINDING_PARAMETERS = ["RelayState", "SAMLRequest", "SigAlg", "Signature"];

export type SamlIdpMetadata = {
  /** Signing certificates as PEM, deduplicated. */
  certificates: string[];
  entityId: string;
  /** HTTP-Redirect single sign-on locations, in document order. */
  ssoUrls: string[];
};

export type SamlCertificateInspection =
  | { problem: "certificate_invalid"; validTo: null }
  | { problem: "certificate_expired" | null; validTo: Date };

/** Why fetched metadata is unusable; matched by `code`, since the fetch loads lazily. */
export class SamlMetadataFetchError extends Error {
  constructor(readonly code: "metadata_invalid" | "metadata_unreachable") {
    super(code);
    this.name = "SamlMetadataFetchError";
  }
}

export function samlMetadataFetchFailure(error: unknown): "metadata_invalid" | "metadata_unreachable" {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return code === "metadata_invalid" ? code : "metadata_unreachable";
}

/** The certificate's base64 body without armor or whitespace: equal bodies are one certificate. */
function certificateBody(value: string): string {
  return value.replace(/-----(?:BEGIN|END) CERTIFICATE-----/gu, "").replace(/\s+/gu, "");
}

/** A certificate as PEM, from PEM or from the bare base64 that metadata and IdP consoles show. */
export function samlCertificatePem(value: string): string | null {
  const body = certificateBody(value);
  if (!body || body.length > 16_000 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(body)) return null;
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/gu)!.join("\n")}\n-----END CERTIFICATE-----`;
}

export function sameSamlCertificate(left: string, right: string): boolean {
  return certificateBody(left) === certificateBody(right);
}

/**
 * Whether a pinned certificate can verify this IdP's signatures: an X.509 certificate with an
 * RSA key of at least 2048 bits (what xml-crypto verifies), not expired. A certificate that is
 * not valid yet passes, so the next one can be added before the IdP rotates.
 */
export function inspectSamlCertificate(pem: string, now: Date): SamlCertificateInspection {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(pem);
  } catch {
    return { problem: "certificate_invalid", validTo: null };
  }
  const key = certificate.publicKey;
  const modulusBits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  const validTo = certificate.validToDate;
  if ((key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "rsa-pss") || modulusBits < MIN_RSA_MODULUS_BITS ||
    Number.isNaN(validTo.getTime())) {
    return { problem: "certificate_invalid", validTo: null };
  }
  return { problem: validTo.getTime() <= now.getTime() ? "certificate_expired" : null, validTo };
}

/** An absolute http(s) URL without credentials, fragment or binding parameters. */
export function usableSamlUrl(value: string): boolean {
  if (value.length > URL_MAX_LENGTH || CONTROL_CHARACTERS.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.hostname) &&
      !url.username && !url.password && !url.hash &&
      BINDING_PARAMETERS.every((name) => !url.searchParams.has(name));
  } catch {
    return false;
  }
}

/**
 * The one SAML 2.0 IdP an `EntityDescriptor` (alone or inside an `EntitiesDescriptor`)
 * describes, or null. Metadata is parsed like a response: bounded, without a DTD, strictly.
 */
export function parseSamlIdpMetadata(xml: string): SamlIdpMetadata | null {
  let document: Document;
  try {
    document = parseSamlXml(xml, SAML_METADATA_XML_MAX_LENGTH);
  } catch {
    return null;
  }
  const identityProviders = elementsByLocalName(document, "EntityDescriptor")
    .filter((entity) => entity.namespaceURI === SAML_METADATA_NAMESPACE)
    .flatMap((entity) => childElements(entity, SAML_METADATA_NAMESPACE, "IDPSSODescriptor")
      .filter((descriptor) => (descriptor.getAttribute("protocolSupportEnumeration") ?? "").split(/\s+/u).includes(SAML2_PROTOCOL))
      .map((descriptor) => ({ descriptor, entity })));
  if (identityProviders.length !== 1) return null;
  const { descriptor, entity } = identityProviders[0]!;

  const entityId = (entity.getAttribute("entityID") ?? "").trim();
  if (!entityId || entityId.length > ENTITY_ID_MAX_LENGTH || CONTROL_CHARACTERS.test(entityId)) return null;

  const ssoUrls = childElements(descriptor, SAML_METADATA_NAMESPACE, "SingleSignOnService")
    .filter((service) => service.getAttribute("Binding") === HTTP_REDIRECT_BINDING)
    .map((service) => (service.getAttribute("Location") ?? "").trim())
    .filter(usableSamlUrl);

  const certificates: string[] = [];
  for (const keyDescriptor of childElements(descriptor, SAML_METADATA_NAMESPACE, "KeyDescriptor")) {
    const use = keyDescriptor.getAttribute("use") ?? "";
    if (use && use !== "signing") continue;
    for (const element of Array.from(keyDescriptor.getElementsByTagNameNS(XML_SIGNATURE_NAMESPACE, "X509Certificate"))) {
      const pem = samlCertificatePem(element.textContent ?? "");
      if (pem && !certificates.some((known) => sameSamlCertificate(known, pem))) certificates.push(pem);
    }
  }
  return { certificates, entityId, ssoUrls };
}
