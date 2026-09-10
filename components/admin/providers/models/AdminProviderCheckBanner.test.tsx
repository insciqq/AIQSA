import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fixtureCheckRun, fixtureConnection, fixtureModel } from "../providerFixtures";
import { AdminProviderCheckBanner } from "./AdminProviderCheckBanner";
import type { AdminProviderCheckRun } from "@/lib/contracts/adminProviders";

function fixture(results: AdminProviderCheckRun["results"], failed: string[] = []) {
  const model = fixtureModel({ id: "m", displayName: "Fixture model", connectionId: "c" });
  const restart = vi.fn(async () => true);
  const props = { disabled: false, connection: fixtureConnection({ id: "c", displayName: "Fixture provider", models: [model] }),
    checks: { interrupted: null, dismissInterrupted: vi.fn(), restart, stop: vi.fn(async () => true),
      run: fixtureCheckRun({ id: "run", credentialId: "key", state: "completed", done: 1, total: 1, failed, results }) } };
  render(<AdminProviderCheckBanner {...props} />);
  return { restart };
}

describe("independent model check feedback", () => {
  it("shows an actionable bounded PDF failure while keeping verified model access", async () => {
    const { restart } = fixture([{ providerModelId: "m", state: "partial", checks: {
      modelAccess: "verified", directPdf: "incomplete", streaming: "verified"
    }, attempts: { directPdf: { attempts: 2, status: "incomplete", reason: "budget_exhausted" } } }], ["m"]);
    expect(screen.getByText("Some checks need another attempt.")).toHaveClass("font-semibold", "text-critical");
    expect(screen.getByText(/Direct PDF: inconclusive/)).toHaveTextContent("output budget exhausted · 2 attempts");
    expect(screen.getByText(/Direct PDF: inconclusive/)).toHaveClass("font-semibold", "text-critical");
    expect(screen.getByText("Model access: verified")).toBeVisible();
    expect(screen.queryByText(/Model unavailable|temporary failure/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry checks" }));
    expect(restart).toHaveBeenCalledOnce();
  });

  it("does not request another attempt for settled unsupported image routes", () => {
    fixture([{ providerModelId: "m", state: "unavailable", checks: {
      modelAccess: "unsupported", imageGeneration: "unsupported", imageEditing: "unsupported"
    }, attempts: { imageGeneration: { attempts: 1, status: "unsupported", reason: "route_unsupported", httpStatus: 404 } } }]);
    expect(screen.getByText("Model checks finished.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Image generation: unsupported/)).toHaveTextContent("HTTP 404 · 1 attempt");
  });

  it("distinguishes a failed refresh from its retained proof and a failed save", () => {
    fixture([{ providerModelId: "m", state: "save_failed", checks: { modelAccess: "verified", vision: "verified" },
      attempts: { vision: { attempts: 1, status: "incomplete", reason: "timeout" } } }], ["m"]);
    expect(screen.getByText(/Image input: verified previously/)).toHaveTextContent("latest check inconclusive — check timed out");
    expect(screen.getByText(/The latest checked settings were not saved/)).toHaveClass("text-critical");
  });
});
