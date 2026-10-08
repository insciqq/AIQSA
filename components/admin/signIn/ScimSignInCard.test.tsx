import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminConfirmationRequest } from "@/components/admin/useAdminConfirmationController";
import type { AdminScimToken } from "@/lib/contracts/adminScim";
import type { AdminSignInMethodState, AdminSignInOverview } from "@/lib/contracts/adminSignIn";
import { AdminSignInSection } from "./AdminSignInSection";

const NEW_TOKEN = "aiqsa_scim_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

function scimState(overrides: Partial<AdminSignInMethodState<"scim">> = {}): AdminSignInMethodState {
  return {
    active: { activatedAt: null, config: null, enabled: false, secrets: {}, version: 0 },
    draft: { config: null, matchesActive: false, secrets: {}, test: null, version: 0 },
    environmentConfigured: false,
    health: { lastAcceptedAt: null, lastAttemptAt: null, lastFailureAt: null, lastFailureCode: null },
    method: "scim",
    problem: null,
    requiresTest: false,
    status: "off",
    ...overrides
  } as AdminSignInMethodState;
}

function token(id: string, overrides: Partial<AdminScimToken> = {}): AdminScimToken {
  return {
    createdAt: "2026-10-08T10:00:00.000Z",
    displayPrefix: `aiqsa_scim_${id.slice(-4)}`,
    id,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides
  };
}

type Call = { body: unknown; method: string; url: string };

function mockApi(input: {
  handle?: (call: Call) => Response | null;
  method?: AdminSignInMethodState;
  tokens?: AdminScimToken[];
}) {
  const calls: Call[] = [];
  const overview: AdminSignInOverview = {
    appBaseUrl: "https://aiqsa.example",
    currentSessionSignInMethod: "password",
    methods: [input.method ?? scimState()],
    policy: { passwordLoginEnabled: true, registrationEnabled: true, updatedAt: null, version: 0 }
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    const url = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url;
    const call = { body: init?.body ? JSON.parse(String(init.body)) : null, method: init?.method ?? "GET", url };
    calls.push(call);
    if (url === "/api/admin/sign-in" && call.method === "GET") return Response.json(overview);
    if (url === "/api/admin/sign-in/scim/tokens" && call.method === "GET") return Response.json({ tokens: input.tokens ?? [] });
    return input.handle?.(call) ?? Response.json({ error: "unexpected_request" }, { status: 500 });
  });
  return calls;
}

const notices: string[] = [];
const confirmations: AdminConfirmationRequest[] = [];

function renderSection() {
  notices.length = 0;
  confirmations.length = 0;
  render(
    <AdminSignInSection
      feedback={{ reportError: vi.fn(), reportNotice: (message) => { notices.push(message); } }}
      requestConfirmation={(request) => { confirmations.push(request); }}
    />
  );
  return screen.findByTestId("admin-sign-in-card-scim");
}

describe("SCIM sign-in card", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers the base URL, saves the link method and activates without a test", async () => {
    const saved = scimState({ draft: { config: { linkMethod: "oidc" }, matchesActive: false, secrets: {}, test: null, version: 1 } });
    const calls = mockApi({
      handle: (call) => call.method === "PUT"
        ? Response.json({ method: saved })
        : call.method === "POST" && call.url === "/api/admin/sign-in/methods/scim"
          ? Response.json({ method: { ...saved, status: "active_admin" } })
          : null
    });
    const card = await renderSection();

    expect(within(card).getByDisplayValue("https://aiqsa.example/scim/v2")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Test" })).toBeNull();
    const select = within(card).getByLabelText("Link SCIM users to sign-in method");
    expect(select).toHaveValue("");
    expect(within(card).getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(select, { target: { value: "oidc" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(card).getByRole("button", { name: "Activate" })).toBeEnabled());
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      config: { linkMethod: "oidc" },
      expectedDraftVersion: 0,
      secretActions: {}
    });

    fireEvent.click(within(card).getByRole("button", { name: "Activate" }));
    await waitFor(() => expect(within(card).getByTestId("admin-sign-in-status")).toHaveTextContent("Active (admin)"));
    expect(calls.at(-1)?.body).toEqual({ action: "activate", expectedActiveVersion: 0, expectedDraftVersion: 1 });
    expect(notices).toEqual(["SCIM provisioning is active."]);

    fireEvent.click(within(card).getByRole("button", { name: "Disable" }));
    expect(confirmations.at(-1)).toMatchObject({ title: "Disable SCIM provisioning?" });
    expect(confirmations.at(-1)?.body).toContain("every SCIM request is refused");
  });

  it("shows a new token once and lists tokens only by prefix", async () => {
    const issued = [token("token-0001")];
    const calls = mockApi({
      handle: (call) => call.method === "POST" && call.url === "/api/admin/sign-in/scim/tokens"
        ? Response.json({ token: NEW_TOKEN, tokens: issued }, { status: 201 })
        : null
    });
    const card = await renderSection();
    const tokens = within(card).getByTestId("admin-scim-tokens");

    await waitFor(() => expect(tokens).toHaveTextContent("No tokens yet."));
    fireEvent.click(within(tokens).getByRole("button", { name: "Generate token" }));

    const shown = await within(tokens).findByTestId("admin-scim-token-issued");
    expect(within(shown).getByLabelText("New SCIM token")).toHaveValue(NEW_TOKEN);
    expect(calls.at(-1)?.body).toEqual({ action: "create" });
    expect(within(tokens).getByTestId("admin-scim-token")).toHaveTextContent("aiqsa_scim_0001…");
    expect(within(tokens).getByTestId("admin-scim-token")).toHaveTextContent("Not used yet");

    fireEvent.click(within(shown).getByRole("button", { name: "Done" }));
    expect(within(tokens).queryByTestId("admin-scim-token-issued")).toBeNull();
    expect(document.body.innerHTML).not.toContain(NEW_TOKEN);
  });

  it("keeps a new token on screen while an older one is revoked", async () => {
    const older = token("token-0001");
    const newer = token("token-0002");
    mockApi({
      handle: (call) => {
        const body = call.body as { action?: string } | null;
        if (body?.action === "create") return Response.json({ token: NEW_TOKEN, tokens: [newer, older] }, { status: 201 });
        if (body?.action === "revoke") return Response.json({ tokens: [newer, { ...older, revokedAt: "2026-10-08T12:00:00.000Z" }] });
        return null;
      },
      tokens: [older]
    });
    const card = await renderSection();
    const tokens = within(card).getByTestId("admin-scim-tokens");
    await waitFor(() => expect(within(tokens).getAllByTestId("admin-scim-token")).toHaveLength(1));

    fireEvent.click(within(tokens).getByRole("button", { name: "Generate token" }));
    await within(tokens).findByTestId("admin-scim-token-issued");
    const olderRow = within(tokens).getAllByTestId("admin-scim-token").find((row) => row.textContent?.includes("aiqsa_scim_0001"))!;
    fireEvent.click(within(olderRow).getByRole("button", { name: "Revoke" }));
    fireEvent.click(within(olderRow).getByRole("button", { name: "Revoke token" }));

    await waitFor(() => expect(within(tokens).getAllByTestId("admin-scim-token").filter((row) =>
      row.getAttribute("data-revoked") === "true")).toHaveLength(1));
    expect(within(within(tokens).getByTestId("admin-scim-token-issued")).getByLabelText("New SCIM token")).toHaveValue(NEW_TOKEN);
  });

  it("revokes a token after an inline confirmation", async () => {
    const calls = mockApi({
      handle: (call) => call.method === "POST"
        ? Response.json({ tokens: [token("token-0001", { revokedAt: "2026-10-08T12:00:00.000Z" })] })
        : null,
      tokens: [token("token-0001", { lastUsedAt: "2026-10-08T11:00:00.000Z" })]
    });
    const card = await renderSection();
    const row = await within(card).findByTestId("admin-scim-token");
    expect(row).toHaveTextContent("Last used");

    fireEvent.click(within(row).getByRole("button", { name: "Revoke" }));
    expect(within(row).getByTestId("admin-scim-token-confirm")).toHaveTextContent("refused at once");
    fireEvent.click(within(row).getByRole("button", { name: "Revoke token" }));

    await waitFor(() => expect(within(card).getByTestId("admin-scim-token")).toHaveAttribute("data-revoked", "true"));
    expect(calls.at(-1)?.body).toEqual({ action: "revoke", tokenId: "token-0001" });
    expect(within(card).getByTestId("admin-scim-token")).toHaveTextContent("Revoked");
  });

  it("stops offering new tokens at the active limit and words health for SCIM requests", async () => {
    mockApi({
      method: scimState({
        health: {
          lastAcceptedAt: "2026-10-08T09:00:00.000Z",
          lastAttemptAt: "2026-10-08T10:00:00.000Z",
          lastFailureAt: "2026-10-08T10:00:00.000Z",
          lastFailureCode: "owner_transfer_required"
        }
      }),
      tokens: Array.from({ length: 5 }, (_, index) => token(`token-000${index}`))
    });
    const card = await renderSection();

    await waitFor(() => expect(within(card).getAllByTestId("admin-scim-token")).toHaveLength(5));
    expect(within(card).getByRole("button", { name: "Generate token" })).toBeDisabled();
    expect(within(card).getByTestId("admin-sign-in-health"))
      .toHaveTextContent("Last SCIM request failed");
    expect(within(card).getByTestId("admin-sign-in-health"))
      .toHaveTextContent("a deactivated user still owns Projects alone; transfer their ownership.");
  });
});
