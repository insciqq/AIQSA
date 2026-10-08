// @vitest-environment node
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { samlSignInConfigSchema } from "@/lib/contracts/authSignInMethods";
import { createSamlTestIdp, samlTestIdpMetadata, selfSignedCertificate } from "@/tests/support/samlIdp";
import { signInMethodServerRegistry } from "../signInSettings/methods";
import { SamlMetadataFetchError } from "./metadata";
import { createSamlSignInMethod, samlSignInMethod, type SamlMetadataFetcher } from "./method";

const idp = createSamlTestIdp();
const otherIdp = createSamlTestIdp();
const SSO_URL = "https://idp.example.test/realms/aiqsa/protocol/saml";
const METADATA_URL = "https://idp.example.test/realms/aiqsa/protocol/saml/descriptor";

function config(overrides: Record<string, unknown> = {}) {
  return samlSignInConfigSchema.parse({
    idpCertificates: [idp.certificate],
    idpEntityId: idp.entityId,
    idpSsoUrl: SSO_URL,
    ...overrides
  });
}

async function test(overrides: Record<string, unknown> = {}, fetchMetadata?: SamlMetadataFetcher) {
  const method = createSamlSignInMethod(fetchMetadata ? { fetchMetadata } : {});
  return method.test!({
    appBaseUrl: "https://aiqsa.example",
    config: config(overrides),
    secrets: {},
    signal: AbortSignal.timeout(5_000)
  });
}

describe("SAML sign-in tester", () => {
  it("is the registered SAML definition and binds identities to the IdP entity id", () => {
    expect(signInMethodServerRegistry.saml).toBe(samlSignInMethod);
    expect(samlSignInMethod.identitySource!(config())).toBe(idp.entityId);
  });

  it("passes a configuration whose certificates can verify signatures", async () => {
    await expect(test()).resolves.toEqual({ code: "configuration_checked", passed: true });
    await expect(test({ groupsAttribute: "groups", syncGroups: true })).resolves.toMatchObject({ passed: true });
  });

  it("names configurations that could never sign anybody in correctly", async () => {
    const now = Date.now();
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const expired = selfSignedCertificate({ notAfter: new Date(now - 1_000), notBefore: new Date(now - 86_400_000), privateKey, publicKey });

    const cases: [Record<string, unknown>, string][] = [
      [{ nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient" }, "nameid_transient"],
      [{ allowedGroups: ["staff"] }, "groups_attribute_required"],
      [{ adminGroups: ["admins"] }, "groups_attribute_required"],
      [{ syncGroups: true }, "groups_attribute_required"],
      [{ idpSsoUrl: `${SSO_URL}?SAMLRequest=fixed` }, "sso_url_invalid"],
      [{ idpCertificates: [idp.certificate, expired] }, "certificate_expired"],
      [{ idpCertificates: ["-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----"] }, "certificate_invalid"]
    ];
    for (const [overrides, code] of cases) {
      await expect(test(overrides), code).resolves.toEqual({ code, passed: false });
    }
    await expect(test({
      nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
      subjectAttribute: "uid"
    })).resolves.toMatchObject({ passed: true });
  });

  it("checks the configuration against the IdP's current metadata when a metadata URL is set", async () => {
    const published = (input: { certificates?: string[]; entityId?: string; ssoUrl?: string } = {}): SamlMetadataFetcher =>
      vi.fn(async () => samlTestIdpMetadata({
        certificates: input.certificates ?? [idp.certificate, otherIdp.certificate],
        entityId: input.entityId ?? idp.entityId,
        ssoUrl: input.ssoUrl ?? SSO_URL
      }));
    const withMetadata = { idpMetadataUrl: METADATA_URL };

    const fetcher = published();
    await expect(test(withMetadata, fetcher)).resolves.toEqual({ code: "configuration_checked", passed: true });
    expect(fetcher).toHaveBeenCalledWith(METADATA_URL, { signal: expect.any(AbortSignal) });

    const cases: [SamlMetadataFetcher, string][] = [
      [async () => { throw new SamlMetadataFetchError("metadata_unreachable"); }, "metadata_unreachable"],
      [async () => { throw new SamlMetadataFetchError("metadata_invalid"); }, "metadata_invalid"],
      [async () => { throw new Error("unexpected"); }, "metadata_unreachable"],
      [async () => "<not-metadata/>", "metadata_invalid"],
      [published({ entityId: "https://other-idp.example.test" }), "metadata_mismatch"],
      [published({ ssoUrl: "https://idp.example.test/other/sso" }), "sso_url_invalid"],
      [published({ certificates: [otherIdp.certificate] }), "metadata_mismatch"]
    ];
    for (const [fetchMetadata, code] of cases) {
      await expect(test(withMetadata, fetchMetadata), code).resolves.toEqual({ code, passed: false });
    }
  });
});
