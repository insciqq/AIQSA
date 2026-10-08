import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminSignInMethodState, AdminSignInOverview } from "@/lib/contracts/adminSignIn";
import { samlSignInConfigSchema } from "@/lib/contracts/authSignInMethods";
import { AdminSignInSection } from "./AdminSignInSection";
import { parseSamlCertificates, parseSamlGroupList, samlCardForm, samlConfigFromForm } from "./samlSignInView";

const CERTIFICATE = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUSyntheticTestCertificate\n-----END CERTIFICATE-----";
const ENTITY_ID = "https://idp.example.test/realms/aiqsa";
const SSO_URL = "https://idp.example.test/realms/aiqsa/protocol/saml";
const METADATA_URL = "https://idp.example.test/realms/aiqsa/protocol/saml/descriptor";

function configFor(overrides: Record<string, unknown> = {}) {
  return samlSignInConfigSchema.parse({ idpCertificates: [CERTIFICATE], idpEntityId: ENTITY_ID, idpSsoUrl: SSO_URL, ...overrides });
}

function saml(overrides: Partial<AdminSignInMethodState> = {}): AdminSignInMethodState {
  return {
    active: { activatedAt: null, config: null, enabled: false, secrets: {}, version: 0 },
    draft: { config: null, matchesActive: false, secrets: {}, test: null, version: 0 },
    environmentConfigured: false,
    health: { lastAcceptedAt: null, lastAttemptAt: null, lastFailureAt: null, lastFailureCode: null },
    method: "saml",
    problem: null,
    requiresTest: true,
    status: "off",
    ...overrides
  } as AdminSignInMethodState;
}

function overview(method = saml()): AdminSignInOverview {
  return {
    appBaseUrl: "https://aiqsa.example",
    currentSessionSignInMethod: "password",
    methods: [method],
    policy: { passwordLoginEnabled: true, registrationEnabled: true, updatedAt: null, version: 0 }
  };
}

type Call = { body: unknown; method: string; url: string };

function mockApi(handlers: (call: Call) => Response | null, initial = overview()) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call = { body: init?.body ? JSON.parse(String(init.body)) : null, method: init?.method ?? "GET", url };
    calls.push(call);
    if (url === "/api/admin/sign-in" && call.method === "GET") return Response.json(initial);
    return handlers(call) ?? Response.json({ error: "unexpected_request" }, { status: 500 });
  });
  return calls;
}

function renderSection() {
  render(<AdminSignInSection feedback={{ reportError: vi.fn(), reportNotice: vi.fn() }} requestConfirmation={vi.fn()} />);
  return screen.findByTestId("admin-sign-in-card-saml");
}

describe("SamlSignInCard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the SP values to copy into the IdP and the IdP hints", async () => {
    mockApi(() => null);
    const card = await renderSection();

    expect(within(card).getByLabelText("SP entity ID (Audience)")).toHaveValue("https://aiqsa.example/saml/metadata");
    expect(within(card).getByLabelText("ACS URL (Reply URL)")).toHaveValue("https://aiqsa.example/saml/acs");
    expect(within(card).getByLabelText("SP metadata URL")).toHaveValue("https://aiqsa.example/saml/metadata");
    expect(within(card).getByTestId("admin-saml-hints")).toHaveTextContent("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress");
    expect(within(card).getByTestId("admin-saml-hints")).toHaveTextContent("Client signature required");
    expect(within(card).getByLabelText("Require signed assertions")).toBeChecked();
    expect(within(card).getByRole("button", { name: "Activate" })).toBeDisabled();
  });

  it("fills the IdP fields from metadata for review, then saves exactly what the administrator confirmed", async () => {
    const saved = saml({
      draft: {
        config: configFor({ groupsAttribute: "groups", idpMetadataUrl: METADATA_URL, syncGroups: true }),
        matchesActive: false,
        secrets: {},
        test: null,
        version: 1
      }
    });
    const calls = mockApi((call) => {
      if (call.url === "/api/admin/sign-in/saml/metadata") {
        return Response.json({ metadata: { certificates: [{ pem: CERTIFICATE, validTo: "2027-10-08T00:00:00.000Z" }], entityId: ENTITY_ID, ssoUrl: SSO_URL } });
      }
      if (call.url === "/api/admin/sign-in/methods/saml" && call.method === "PUT") return Response.json({ method: saved });
      return null;
    });
    const card = await renderSection();

    fireEvent.change(within(card).getByLabelText("Load from IdP metadata URL"), { target: { value: METADATA_URL } });
    fireEvent.click(within(card).getByRole("button", { name: "Load" }));
    await waitFor(() => expect(within(card).getByLabelText("IdP entity ID")).toHaveValue(ENTITY_ID));
    expect(within(card).getByTestId("admin-saml-metadata-message")).toHaveTextContent("Loaded the entity ID, the sign-in URL and 1 certificate");
    expect(within(card).getByLabelText("IdP sign-in URL (HTTP-Redirect)")).toHaveValue(SSO_URL);
    expect(within(card).getByLabelText("IdP signing certificates")).toHaveValue(CERTIFICATE);
    expect(calls.find((call) => call.url === "/api/admin/sign-in/saml/metadata")?.body).toEqual({ metadataUrl: METADATA_URL });

    fireEvent.change(within(card).getByLabelText("Groups attribute (optional)"), { target: { value: "groups" } });
    fireEvent.click(within(card).getByLabelText("Sync group memberships"));
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    const put = calls.find((call) => call.method === "PUT")!;
    expect(put.body).toEqual({
      config: expect.objectContaining({
        groupsAttribute: "groups",
        idpCertificates: [CERTIFICATE],
        idpEntityId: ENTITY_ID,
        idpMetadataUrl: METADATA_URL,
        idpSsoUrl: SSO_URL,
        nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
        requireSignedAssertion: true,
        syncGroups: true
      }),
      expectedDraftVersion: 0,
      secretActions: {}
    });
  });

  it("marks missing fields instead of saving, and shows a metadata failure in words", async () => {
    const calls = mockApi((call) => call.url === "/api/admin/sign-in/saml/metadata"
      ? Response.json({ error: "metadata_unreachable" }, { status: 422 })
      : null);
    const card = await renderSection();

    fireEvent.change(within(card).getByLabelText("Button label"), { target: { value: "Acme SSO" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));
    expect(await within(card).findByText("Enter the IdP entity ID.")).toBeInTheDocument();
    expect(within(card).getByText("Paste the IdP signing certificate as PEM.")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);

    fireEvent.change(within(card).getByLabelText("Load from IdP metadata URL"), { target: { value: METADATA_URL } });
    fireEvent.click(within(card).getByRole("button", { name: "Load" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("The metadata URL could not be reached from AIQSA.");
  });

  it("reads the tester's and the last sign-in's codes as sentences", async () => {
    mockApi(() => null, overview(saml({
      draft: {
        config: configFor(),
        matchesActive: false,
        secrets: {},
        test: { attemptedAt: "2026-10-08T12:00:00.000Z", code: "nameid_transient", passed: false, version: 1 },
        version: 1
      },
      health: {
        lastAcceptedAt: null,
        lastAttemptAt: "2026-10-08T12:00:00.000Z",
        lastFailureAt: "2026-10-08T12:00:00.000Z",
        lastFailureCode: "signature_invalid"
      }
    })));
    const card = await renderSection();

    expect(within(card).getByTestId("admin-sign-in-test")).toHaveTextContent("Test failed: A transient NameID changes with every sign-in.");
    expect(within(card).getByTestId("admin-sign-in-health")).toHaveTextContent("the signature was missing or did not match a pinned certificate");
  });
});

describe("SAML card values", () => {
  it("accepts PEM blocks or one bare body and keeps group values exact", () => {
    expect(parseSamlCertificates(`${CERTIFICATE}\n\n${CERTIFICATE.replace("Synthetic", "Second")}`)).toHaveLength(2);
    expect(parseSamlCertificates("MIIBszCCAVmgAwIBAgIUSynthetic")).toEqual(["-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUSynthetic\n-----END CERTIFICATE-----"]);
    expect(parseSamlCertificates(`${CERTIFICATE}\nnot base64!`)).toBeNull();
    expect(parseSamlGroupList(" Team Leads \r\n\n/staff")).toEqual([" Team Leads ", "/staff"]);
  });

  it("requires a signature and names the field to fix", () => {
    const result = samlConfigFromForm({
      ...samlCardForm(null),
      idpCertificates: CERTIFICATE,
      idpEntityId: ENTITY_ID,
      idpSsoUrl: "ftp://idp.example.test/sso",
      requireSignedAssertion: false
    });
    expect(result).toEqual({ errors: { requireSignedAssertion: "Require signed assertions, signed responses or both." }, ok: false });

    expect(samlConfigFromForm({ ...samlCardForm(null), idpCertificates: CERTIFICATE, idpEntityId: ENTITY_ID, idpSsoUrl: "ftp://idp.example.test/sso" }))
      .toEqual({ errors: { idpSsoUrl: "Enter an http(s) URL without credentials or fragment." }, ok: false });
  });
});
