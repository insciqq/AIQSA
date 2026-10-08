// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createSamlTestIdp, samlTestIdpMetadata } from "@/tests/support/samlIdp";
import type { AuthenticatedSession } from "../requestAuth";
import { createAdminSamlMetadataHandler } from "./adminMetadata";
import { sameSamlCertificate, SamlMetadataFetchError } from "./metadata";
import type { SamlMetadataFetcher } from "./method";

const idp = createSamlTestIdp();
const SSO_URL = "https://idp.example.test/realms/aiqsa/protocol/saml";
const METADATA = samlTestIdpMetadata({ certificates: [idp.certificate], entityId: idp.entityId, ssoUrl: SSO_URL });

function session(role: "admin" | "user" = "admin"): AuthenticatedSession {
  return {
    expiresAt: new Date(Date.now() + 3_600_000),
    id: "session-1",
    user: { displayName: "Operator", email: null, id: "user-1", role, status: "active" },
    userId: "user-1"
  };
}

function handler(input: { fetchMetadata?: SamlMetadataFetcher; role?: "admin" | "user" | null } = {}) {
  const fetchMetadata = vi.fn<SamlMetadataFetcher>(input.fetchMetadata ?? (async () => METADATA));
  const role = input.role === undefined ? "admin" : input.role;
  const post = createAdminSamlMetadataHandler({
    fetchMetadata,
    resolveAuth: async () => (role ? session(role) : null)
  });
  const call = (body: unknown, contentType = "application/json") => post(new Request("https://aiqsa.example/api/admin/sign-in/saml/metadata", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": contentType },
    method: "POST"
  }));
  return { call, fetchMetadata };
}

describe("admin SAML metadata import", () => {
  it("parses pasted metadata into the values the administrator confirms", async () => {
    const { call, fetchMetadata } = handler();

    const response = await call({ metadataXml: METADATA });
    const body = await response.json() as { metadata: { certificates: { pem: string; validTo: string }[]; entityId: string; ssoUrl: string } };

    expect(response.status).toBe(200);
    expect(body.metadata).toEqual({
      certificates: [{ pem: expect.any(String), validTo: expect.any(String) }],
      entityId: idp.entityId,
      ssoUrl: SSO_URL
    });
    expect(sameSamlCertificate(body.metadata.certificates[0]!.pem, idp.certificate)).toBe(true);
    expect(fetchMetadata).not.toHaveBeenCalled();
  });

  it("fetches a metadata URL with a deadline and reports transport failures as a stable code", async () => {
    const { call, fetchMetadata } = handler();
    await expect((await call({ metadataUrl: "https://idp.example.test/descriptor" })).json())
      .resolves.toMatchObject({ metadata: { entityId: idp.entityId } });
    expect(fetchMetadata).toHaveBeenCalledWith("https://idp.example.test/descriptor", { signal: expect.any(AbortSignal) });

    const unreachable = handler({ fetchMetadata: async () => { throw new SamlMetadataFetchError("metadata_unreachable"); } });
    const response = await unreachable.call({ metadataUrl: "https://idp.example.test/descriptor" });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "metadata_unreachable" });
  });

  it("names unusable metadata without echoing it", async () => {
    const { call } = handler();
    const cases: [string, string][] = [
      ["<html>Sign in</html>", "metadata_invalid"],
      [METADATA.replace("urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect", "urn:oasis:names:tc:SAML:2.0:bindings:SOAP"), "sso_url_invalid"],
      [METADATA.replace(/<md:KeyDescriptor[\s\S]*<\/md:KeyDescriptor>/u, ""), "certificate_invalid"]
    ];
    for (const [metadataXml, error] of cases) {
      const response = await call({ metadataXml });
      expect(response.status, error).toBe(422);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error });
      expect(text).not.toContain(idp.entityId);
    }
  });

  it("is for active administrators only and accepts exactly one bounded source", async () => {
    expect((await handler({ role: null }).call({ metadataXml: METADATA })).status).toBe(401);
    expect((await handler({ role: "user" }).call({ metadataXml: METADATA })).status).toBe(403);
    expect((await handler().call({ metadataXml: METADATA }, "text/plain")).status).toBe(415);
    for (const body of [{}, { metadataUrl: "https://a.example", metadataXml: METADATA }, { metadataXml: 3 }, { metadataXml: "x".repeat(512 * 1024 + 1) }, "[]"]) {
      await expect((await handler().call(body)).json()).resolves.toEqual({ error: "metadata_request_invalid" });
    }
  });
});
