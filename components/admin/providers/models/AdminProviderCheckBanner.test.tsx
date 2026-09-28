import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fixtureCheckRun, fixtureConnection, fixtureModel } from "../providerFixtures";
import { AdminProviderCheckBanner } from "./AdminProviderCheckBanner";
import type { AdminProviderCheckRun } from "@/lib/contracts/adminProviders";

function fixture(results: AdminProviderCheckRun["results"], failed: string[] = [], overrides: Partial<AdminProviderCheckRun> = {}) {
  const model = fixtureModel({ id: "m", displayName: "Fixture model", connectionId: "c" });
  const restart = vi.fn(async () => true);
  const onOpenMemoryRole = vi.fn();
  const props = { disabled: false, connection: fixtureConnection({ id: "c", displayName: "Fixture provider", models: [model] }),
    onOpenMemoryRole,
    checks: { interrupted: null, dismissInterrupted: vi.fn(), restart, stop: vi.fn(async () => true),
      run: fixtureCheckRun({ id: "run", credentialId: "key", state: "completed", done: 1, total: 1, failed, results, ...overrides }) } };
  render(<AdminProviderCheckBanner {...props} />);
  return { onOpenMemoryRole, restart };
}

const saved: AdminProviderCheckRun["results"] = [{ providerModelId: "m", state: "saved", checks: { modelAccess: "verified" } }];

describe("independent model check feedback", () => {
  it("offers Retry for unconfirmed image generation after editing was saved", () => {
    const { restart } = fixture([{ providerModelId: "m", state: "partial", checks: {
      modelAccess: "verified", imageGeneration: "incomplete", imageEditing: "verified"
    }, attempts: { imageGeneration: { attempts: 1, status: "incomplete", reason: "invalid_input", httpStatus: 400 } } }], ["m"]);
    expect(screen.getByRole("group", { name: "Model setup summary" })).toHaveTextContent("Image checks remain incomplete for 1 model");
    fireEvent.click(screen.getByRole("button", { name: "Retry checks" }));
    expect(restart).toHaveBeenCalledOnce();
  });
  it("finishes quietly when only optional PDF checks are inconclusive", () => {
    const { restart } = fixture([{ providerModelId: "m", state: "partial", checks: {
      modelAccess: "verified", directPdf: "incomplete", streaming: "verified"
    }, attempts: { directPdf: { attempts: 2, status: "incomplete", reason: "budget_exhausted" } } }], ["m"]);
    expect(screen.getByText("Model checks finished.")).toBeVisible();
    expect(screen.getByRole("group", { name: "Model setup summary" })).toHaveTextContent("1 of 1 model results saved.");
    expect(screen.queryByRole("list", { name: "Model setup results" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status").querySelector(".text-critical")).toBeNull();
    expect(screen.queryByText(/Model unavailable|temporary failure/)).not.toBeInTheDocument();
    expect(restart).not.toHaveBeenCalled();
  });

  it("does not request another attempt for settled unsupported image routes", () => {
    fixture([{ providerModelId: "m", state: "unavailable", checks: {
      modelAccess: "unsupported", imageGeneration: "unsupported", imageEditing: "unsupported"
    }, attempts: { imageGeneration: { attempts: 1, status: "unsupported", reason: "route_unsupported", httpStatus: 404 } } }]);
    expect(screen.getByText("Model checks finished.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    expect(screen.getByText(/1 model is unavailable to this key/)).toHaveClass("text-critical");
  });

  it("does not call a failed save successful and keeps a recovery action", () => {
    const { restart } = fixture([{ providerModelId: "m", state: "save_failed", checks: { modelAccess: "verified", vision: "verified" },
      attempts: { vision: { attempts: 1, status: "incomplete", reason: "timeout" } } }], ["m"]);
    expect(screen.getByText("Some setup work is unfinished.")).toHaveClass("text-critical");
    expect(screen.getByText(/0 of 1 model results saved/)).toBeVisible();
    expect(screen.getByText(/Could not save checked settings for Fixture model/)).toHaveClass("text-critical");
    fireEvent.click(screen.getByRole("button", { name: "Retry checks" }));
    expect(restart).toHaveBeenCalledOnce();
  });

  it("keeps an in-flight persisted checkpoint neutral before all capabilities finish", () => {
    fixture([{ providerModelId: "m", state: "partial", checks: { modelAccess: "verified", vision: "not_checked" } }], [], {
      state: "running", done: 0, inFlight: ["m"],
      capabilityProgress: { capability: "vision", completed: 2, total: 7, providerModelId: "m" }
    });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByText("Fixture model: Image input · 2 of 7 checks finished")).toBeVisible();
    expect(screen.queryByRole("group", { name: "Model setup summary" })).not.toBeInTheDocument();
    expect(screen.getByRole("status").querySelector(".text-critical")).toBeNull();
    expect(screen.queryByText(/attention|failed|inconclusive/iu)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop checking" })).toBeEnabled();
  });

  it("finishes setup with a Memory hint instead of Retry when Memory has no qualified model", () => {
    const { onOpenMemoryRole, restart } = fixture(saved, [], { reason: "setup", setup: {
      defaults: ["Chat: Fixture model"], needsConfiguration: ["memory"], search: "ready", state: "completed"
    } });
    expect(screen.getByText("Automatic setup finished.")).not.toHaveClass("text-critical");
    expect(screen.getByText("Search checked and ready.")).toBeVisible();
    expect(screen.getByTestId("provider-setup-memory-hint")).toHaveTextContent("Memory needs a model. Choose one in Defaults & roles");
    expect(screen.queryByText(/could not be saved|unfinished/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry/u })).not.toBeInTheDocument();
    expect(screen.getByRole("status").querySelector(".text-critical")).toBeNull();
    const link = screen.getByRole("link", { name: "Choose one in Defaults & roles" });
    expect(link.getAttribute("href")).toMatch(/\?section=roles&resource=memory$/u);
    fireEvent.click(link);
    expect(onOpenMemoryRole).toHaveBeenCalledOnce();
    expect(restart).not.toHaveBeenCalled();
  });

  it("keeps Retry for a real setup failure next to the Memory hint", () => {
    const { restart } = fixture(saved, [], { reason: "setup", setup: {
      defaults: [], needsConfiguration: ["memory"], search: "failed", state: "partial"
    } });
    expect(screen.getByText("Some setup work is unfinished.")).toHaveClass("text-critical");
    expect(screen.getByText("Search could not be verified. Your saved key and model results are kept.")).toBeVisible();
    expect(screen.getByTestId("provider-setup-memory-hint")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry checks" }));
    expect(restart).toHaveBeenCalledOnce();
  });

  it("keeps the unsaved-defaults copy and Retry for a partial save without the Memory hint", () => {
    fixture(saved, [], { reason: "setup", setup: { defaults: [], search: "ready", state: "partial" } });
    expect(screen.getByText("Some default assignments could not be saved. Retry setup to finish.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry checks" })).toBeVisible();
    expect(screen.queryByTestId("provider-setup-memory-hint")).not.toBeInTheDocument();
  });
});
