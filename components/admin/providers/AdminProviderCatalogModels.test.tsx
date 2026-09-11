import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminProvidersController } from "../useAdminProvidersController";
import { fixtureConnection, fixtureCredential } from "./providerFixtures";
import { AdminProviderCatalogModels } from "./AdminProviderCatalogModels";

const models = ["First", "Second"].map((displayName, index) => ({ displayName, id: `catalog-${index}`,
  upstreamModelId: `vendor/model-${index}`, modelClass: "image" as const }));
const connection = fixtureConnection({ id: "connection", displayName: "Provider", defaultCredentialId: "key",
  credentials: [fixtureCredential({ id: "key", label: "Default production key" })], catalogUpdates: { available: models, skipped: [] } });

function controller() {
  return { state: { busy: false }, actions: {
    addCatalogModels: vi.fn(async () => ({ ok: true, unavailableModelIds: [models[1]!.id] })),
    connectionAction: vi.fn(async () => true)
  } } as unknown as AdminProvidersController;
}

describe("catalog model selection", () => {
  it("starts with all candidates selected, sends only the chosen models with exact key versions and retains unavailable choices", async () => {
    const control = controller();
    render(<AdminProviderCatalogModels connection={connection} controller={control} />);
    expect(screen.getByText("Default production key")).toBeVisible();
    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /First/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add & check selected" }));
    await waitFor(() => expect(control.actions.addCatalogModels).toHaveBeenCalledWith("connection", {
      credentialId: "key", expectedConnectionVersion: connection.activeVersion, expectedCredentialVersionId: "key-version", modelIds: [models[1]!.id]
    }));
    expect(await screen.findByText(/Not available in this key/)).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /Second/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /First/ })).not.toBeChecked();
  });

  it("keeps choices after failure and prevents duplicate submissions before the controller rerenders", async () => {
    const control = controller();
    let finish!: () => void;
    vi.mocked(control.actions.addCatalogModels).mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ ok: false, message: "The key changed. Refresh and retry.",
        error: { code: "provider_draft_stale", blockers: [], resourceIds: [] }, unavailableModelIds: [] });
    }));
    render(<AdminProviderCatalogModels connection={connection} controller={control} />);
    fireEvent.click(screen.getByRole("button", { name: "Add & check selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Add & check selected" }));
    expect(control.actions.addCatalogModels).toHaveBeenCalledOnce();
    finish();
    expect(await screen.findByRole("alert")).toHaveTextContent("The key changed");
    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeChecked();
  });

  it("skips only the selection and restores individual persisted candidates", async () => {
    const control = controller();
    const view = render(<AdminProviderCatalogModels connection={connection} controller={control} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Second/ }));
    fireEvent.click(screen.getByRole("button", { name: "Skip selected" }));
    await waitFor(() => expect(control.actions.connectionAction).toHaveBeenCalledWith("connection", {
      action: "skip_catalog_models", expectedConnectionVersion: connection.activeVersion, modelIds: [models[0]!.id]
    }, expect.any(String), { quiet: true }));
    view.rerender(<AdminProviderCatalogModels connection={{ ...connection, catalogUpdates: { available: [models[1]!], skipped: [models[0]!] } }} controller={control} />);
    fireEvent.click(screen.getByText("Skipped models (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Restore First" }));
    await waitFor(() => expect(control.actions.connectionAction).toHaveBeenLastCalledWith("connection", {
      action: "restore_catalog_models", expectedConnectionVersion: connection.activeVersion, modelIds: [models[0]!.id]
    }, expect.any(String), { quiet: true }));
  });
});
