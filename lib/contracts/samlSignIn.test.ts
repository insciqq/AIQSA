import { describe, expect, it } from "vitest";
import { samlSignInConfigSchema } from "./authSignInMethods";
import { isSamlLoginOutcome, SAML_LOGIN_OUTCOMES, samlServiceProvider } from "./samlSignIn";

const certificate = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUSynthetic\n-----END CERTIFICATE-----";
const base = {
  idpCertificates: [certificate],
  idpEntityId: "https://idp.example.test/realms/aiqsa",
  idpSsoUrl: "https://idp.example.test/realms/aiqsa/protocol/saml"
};

describe("SAML sign-in contract", () => {
  it("derives the SP addresses from the base URL, the entity id defaulting to the metadata URL", () => {
    expect(samlServiceProvider("https://aiqsa.example", null)).toEqual({
      acsUrl: "https://aiqsa.example/saml/acs",
      entityId: "https://aiqsa.example/saml/metadata",
      metadataUrl: "https://aiqsa.example/saml/metadata"
    });
    expect(samlServiceProvider("https://aiqsa.example", "urn:aiqsa:sp").entityId).toBe("urn:aiqsa:sp");
  });

  it("recognizes only the outcomes the login page explains", () => {
    expect(SAML_LOGIN_OUTCOMES).toContain("failed");
    expect(isSamlLoginOutcome("pending")).toBe(true);
    expect(isSamlLoginOutcome("signature_invalid")).toBe(false);
    expect(isSamlLoginOutcome(undefined)).toBe(false);
  });

  it("pins one to four distinct PEM certificates", () => {
    expect(samlSignInConfigSchema.safeParse(base).success).toBe(true);
    for (const idpCertificates of [
      [],
      ["MIIBszCCAVmgAwIBAgIUSynthetic"],
      ["-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----"],
      [certificate, certificate],
      Array.from({ length: 5 }, (_, index) => certificate.replace("Synthetic", `Synthetic${index}`))
    ]) {
      expect(samlSignInConfigSchema.safeParse({ ...base, idpCertificates }).success).toBe(false);
    }
  });
});
