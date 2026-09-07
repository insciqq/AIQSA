import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminProviderAddEntry, preferredProviderConnectionId } from "./AdminProviderAddEntry";
import { fixtureConnection, workingConnection } from "./providerFixtures";
import { providerTemplateIds } from "@/lib/domain/providerTemplates";

const api = vi.hoisted(() => ({
  clear: vi.fn(),
  get: vi.fn(),
  submit: vi.fn()
}));

vi.mock("@/components/admin/adminProviderQuickSetupApi", () => ({
  adminProviderQuickSetupErrorMessage: (error: { code: string }) => error.code,
  clearAdminProviderQuickSetupAssignment: api.clear,
  getAdminProviderQuickSetup: api.get,
  submitAdminProviderQuickSetup: api.submit
}));

function snapshot() {
  return {
    configuredConnections: [{
      activeModelCount: 2,
      displayName: "OpenAI",
      enabled: true,
      family: "openai",
      id: "conn-openai"
    }],
    providers: ["openai", "anthropic", "deepseek", "gemini", "openrouter"].map((provider) => ({
      provider,
      providerDisplayName: provider === "openai" ? "OpenAI" : provider === "deepseek" ? "DeepSeek" : provider === "openrouter" ? "OpenRouter" : provider[0]!.toUpperCase() + provider.slice(1),
      quickSetupAssigned: false,
      state: "not_configured",
      stateToken: `state-${provider}`
    })),
    suggestedProvider: null
  };
}

describe("AdminProviderAddEntry", () => {
  beforeEach(() => {
    api.get.mockReset();
    api.get.mockResolvedValue({ data: snapshot(), ok: true });
  });

  it("shows Quick setup, switches to Custom setup and back, and opens the exact configured connection", async () => {
    const onOpenConnection = vi.fn();
    render(
      <AdminProviderAddEntry
        active
        connections={[workingConnection()]}
        onOpenConnection={onOpenConnection}
        requestConfirmation={vi.fn()}
      />
    );

    expect(await screen.findByRole("heading", { name: "Configured connections" })).toBeVisible();
    fireEvent.click(screen.getByTestId("provider-configured-connection-conn-openai"));
    expect(onOpenConnection).toHaveBeenCalledWith("conn-openai");

    fireEvent.click(screen.getByRole("button", { name: /^Custom/ }));
    expect(screen.getByRole("heading", { name: "Connect a custom endpoint" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(await screen.findByRole("button", { name: /^Custom/ })).toBeInTheDocument();
  });

  it("maps a Quick setup family to its canonical or only connection page", () => {
    const canonical = fixtureConnection({
      displayName: "OpenAI",
      id: providerTemplateIds.openAiConnection
    });
    const other = fixtureConnection({ displayName: "OpenAI EU", id: "conn-eu" });
    const gemini = fixtureConnection({ displayName: "Gemini", family: "gemini", id: "conn-gemini" });
    expect(preferredProviderConnectionId([canonical, other, gemini], "openai")).toBe(providerTemplateIds.openAiConnection);
    expect(preferredProviderConnectionId([other, gemini], "openai")).toBe("conn-eu");
    expect(preferredProviderConnectionId([other, workingConnection()], "openai")).toBeNull();
    expect(preferredProviderConnectionId([gemini], "anthropic")).toBeNull();
    expect(preferredProviderConnectionId([gemini], null)).toBeNull();
  });
});
