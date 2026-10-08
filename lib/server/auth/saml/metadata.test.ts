// @vitest-environment node
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSamlTestIdp, samlTestIdpMetadata, selfSignedCertificate } from "@/tests/support/samlIdp";
import {
  inspectSamlCertificate,
  parseSamlIdpMetadata,
  sameSamlCertificate,
  samlCertificatePem,
  usableSamlUrl
} from "./metadata";
import { createSamlMetadataFetch, fetchSamlMetadata } from "./metadataFetch";

const idp = createSamlTestIdp();
const nextIdp = createSamlTestIdp();
const SSO_URL = "https://idp.example.test/realms/aiqsa/protocol/saml";

function metadata(certificates = [idp.certificate]) {
  return samlTestIdpMetadata({ certificates, entityId: idp.entityId, ssoUrl: SSO_URL });
}

describe("SAML IdP metadata", () => {
  it("reads the entity id, the HTTP-Redirect SSO URL and the signing certificates", () => {
    const parsed = parseSamlIdpMetadata(metadata([idp.certificate, nextIdp.certificate, idp.certificate]));

    expect(parsed).toEqual({
      certificates: [expect.stringContaining("-----BEGIN CERTIFICATE-----"), expect.any(String)],
      entityId: idp.entityId,
      ssoUrls: [SSO_URL]
    });
    expect(sameSamlCertificate(parsed!.certificates[0]!, idp.certificate)).toBe(true);
    expect(sameSamlCertificate(parsed!.certificates[1]!, nextIdp.certificate)).toBe(true);
  });

  it("accepts one IdP inside an EntitiesDescriptor and skips encryption keys", () => {
    const wrapped = `<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">${metadata()
      .replace("<md:EntityDescriptor xmlns:md=\"urn:oasis:names:tc:SAML:2.0:metadata\"", "<md:EntityDescriptor")
      .replace("use=\"signing\"", "use=\"encryption\"")}</md:EntitiesDescriptor>`;

    expect(parseSamlIdpMetadata(wrapped)).toEqual({ certificates: [], entityId: idp.entityId, ssoUrls: [SSO_URL] });
  });

  it("refuses ambiguous, foreign, DTD-carrying or malformed metadata", () => {
    const single = metadata();
    const twoIdps = `<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">${single}${single.replace(idp.entityId, "https://second.example.test")}</md:EntitiesDescriptor>`;

    for (const xml of [
      twoIdps,
      single.replace("urn:oasis:names:tc:SAML:2.0:protocol", "urn:oasis:names:tc:SAML:1.1:protocol"),
      `<!DOCTYPE md [<!ENTITY e "x">]>${single}`,
      single.slice(0, -10),
      "<html><body>Sign in</body></html>"
    ]) {
      expect(parseSamlIdpMetadata(xml)).toBeNull();
    }
  });

  it("keeps only usable HTTP-Redirect SSO URLs", () => {
    expect(parseSamlIdpMetadata(metadata().replace(`Location="${SSO_URL}"`, "Location=\"javascript:alert(1)\""))?.ssoUrls).toEqual([]);
    for (const url of ["ftp://idp.example.test/sso", "https://user:pass@idp.example.test/sso", "https://idp.example.test/sso#x", `${SSO_URL}?SAMLRequest=x`]) {
      expect(usableSamlUrl(url), url).toBe(false);
    }
    expect(usableSamlUrl(`${SSO_URL}?kc_idp_hint=corp`)).toBe(true);
  });
});

describe("SAML certificates", () => {
  it("normalizes bare base64 to PEM and refuses anything else", () => {
    const body = idp.certificate.replace(/-----(?:BEGIN|END) CERTIFICATE-----|\s/gu, "");
    expect(sameSamlCertificate(samlCertificatePem(body)!, idp.certificate)).toBe(true);
    expect(samlCertificatePem("not a certificate!")).toBeNull();
  });

  it("accepts a current RSA certificate and one not yet valid, and names expired or unusable ones", () => {
    const now = new Date();
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const expired = selfSignedCertificate({ notAfter: new Date(now.getTime() - 1_000), notBefore: new Date(now.getTime() - 86_400_000), privateKey, publicKey });
    const upcoming = selfSignedCertificate({ notAfter: new Date(now.getTime() + 2 * 86_400_000), notBefore: new Date(now.getTime() + 86_400_000), privateKey, publicKey });
    const weak = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const weakCertificate = selfSignedCertificate({ notAfter: new Date(now.getTime() + 86_400_000), notBefore: now, ...weak });

    expect(inspectSamlCertificate(idp.certificate, now)).toEqual({ problem: null, validTo: expect.any(Date) });
    expect(inspectSamlCertificate(upcoming, now).problem).toBeNull();
    expect(inspectSamlCertificate(expired, now)).toEqual({ problem: "certificate_expired", validTo: expect.any(Date) });
    expect(inspectSamlCertificate(weakCertificate, now).problem).toBe("certificate_invalid");
    expect(inspectSamlCertificate("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----", now).problem).toBe("certificate_invalid");
  });
});

describe("SAML metadata fetch", () => {
  const signal = () => AbortSignal.timeout(5_000);

  it("returns the body of a successful response and maps failures to stable codes", async () => {
    const ok = vi.fn<typeof fetch>(async () => new Response(metadata(), { headers: { "content-type": "application/samlmetadata+xml" } }));
    await expect(fetchSamlMetadata("https://idp.example.test/metadata", { fetch: ok, signal: signal() })).resolves.toContain(idp.entityId);
    expect(ok.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit", method: "GET", redirect: "follow" });

    const cases: [typeof fetch, string][] = [
      [async () => new Response("missing", { status: 404 }), "metadata_unreachable"],
      [async () => { throw new TypeError("network"); }, "metadata_unreachable"],
      [async () => new Response("x".repeat(600 * 1024)), "metadata_invalid"],
      [async () => new Response(metadata(), { headers: { "content-encoding": "gzip" } }), "metadata_invalid"]
    ];
    for (const [fetcher, code] of cases) {
      await expect(fetchSamlMetadata("https://idp.example.test/metadata", { fetch: fetcher, signal: signal() }))
        .rejects.toMatchObject({ code });
    }
    await expect(fetchSamlMetadata("ftp://idp.example.test/metadata", { fetch: ok, signal: signal() }))
      .rejects.toMatchObject({ code: "metadata_unreachable" });
  });

  it("never sends a byte to link-local or cloud metadata addresses, and marks its egress", async () => {
    const dispatch = vi.fn(async () => new Response(metadata()));
    const toMetadataService = createSamlMetadataFetch({
      dispatch,
      lookupHostname: async () => [{ address: "169.254.169.254", family: 4 }]
    });
    await expect(fetchSamlMetadata("http://idp.example.test/metadata", { fetch: toMetadataService, signal: signal() }))
      .rejects.toMatchObject({ code: "metadata_unreachable" });
    expect(dispatch).not.toHaveBeenCalled();

    const toPublicHost = createSamlMetadataFetch({
      dispatch,
      lookupHostname: async () => [{ address: "93.184.216.34", family: 4 }]
    });
    // Certificates from the internet need TLS: plain HTTP reaches only local addresses.
    await expect(fetchSamlMetadata("http://idp.example.test/metadata", { fetch: toPublicHost, signal: signal() }))
      .rejects.toMatchObject({ code: "metadata_unreachable" });
    expect(dispatch).not.toHaveBeenCalled();
    await expect(fetchSamlMetadata("https://idp.example.test/metadata", { fetch: toPublicHost, signal: signal() }))
      .resolves.toContain(idp.entityId);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0] as unknown as [{ headers: Headers }])[0].headers.get("x-aiqsa-egress")).toBe("personal-mcp");
  });
});
