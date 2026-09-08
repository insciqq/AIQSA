import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import { fixtureCheckRun, workingConnection } from "@/components/admin/providers/providerFixtures";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import { AdminProviderCheckBanner } from "./AdminProviderCheckBanner";
import { useAdminModelChecks } from "./useAdminModelChecks";

const api = vi.hoisted(() => ({ getCheckRun: vi.fn() }));

vi.mock("@/components/admin/adminProvidersApi", () => ({
  getAdminProviderCheckRun: api.getCheckRun
}));

function controller() {
  const actions = {
    cancelModelChecks: vi.fn(async () => true),
    refreshQuietly: vi.fn(async () => true),
    startModelChecks: vi.fn(async () => ({ ok: true as const }))
  };
  return { actions, controller: { actions } as unknown as Pick<AdminProvidersController, "actions"> };
}

function withRun(run: AdminProviderConnection["checkRun"]): AdminProviderConnection {
  return { ...workingConnection(), checkRun: run };
}

describe("useAdminModelChecks", () => {
  beforeEach(() => {
    api.getCheckRun.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls quietly while a run is in progress and reports the end once", async () => {
    vi.useFakeTimers();
    const { actions, controller: value } = controller();
    const onNotice = vi.fn();
    const running = fixtureCheckRun({ credentialId: "cred-primary", done: 1, id: "run-1", inFlight: ["model-luna"], total: 2 });
    const { rerender, result } = renderHook(
      ({ connection }) => useAdminModelChecks({ connection, controller: value, onNotice }),
      { initialProps: { connection: withRun(running) } }
    );
    expect(result.current.run?.state).toBe("running");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_250); });
    expect(actions.refreshQuietly).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_250); });
    expect(actions.refreshQuietly).toHaveBeenCalledTimes(2);

    await act(async () => { await result.current.stop(); });
    expect(actions.cancelModelChecks).toHaveBeenCalledWith("conn-openai", "run-1");

    rerender({ connection: withRun({ ...running, done: 2, failed: ["model-luna"], finishedAt: "2026-09-07T12:52:00.000Z", inFlight: [], state: "completed" }) });
    expect(onNotice).toHaveBeenCalledWith("Checked 2 models · 1 hit a temporary failure — use Retry.");
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(actions.refreshQuietly).toHaveBeenCalledTimes(2);
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(api.getCheckRun).not.toHaveBeenCalled();
  });

  it("recognises a run the server forgot as interrupted and restarts it with the same key", async () => {
    const { actions, controller: value } = controller();
    api.getCheckRun.mockResolvedValue({ data: fixtureCheckRun({ credentialId: "", id: "run-1", state: "interrupted" }), ok: true });
    const running = fixtureCheckRun({ credentialId: "cred-primary", id: "run-1", inFlight: ["model-terra"], total: 2 });
    const { rerender, result } = renderHook(
      ({ connection }) => useAdminModelChecks({ connection, controller: value, onNotice: vi.fn() }),
      { initialProps: { connection: withRun(running) } }
    );
    rerender({ connection: withRun(null) });
    await waitFor(() => expect(result.current.interrupted).toEqual({ credentialId: "cred-primary", id: "run-1" }));
    expect(api.getCheckRun).toHaveBeenCalledWith("conn-openai", "run-1");

    await act(async () => { await result.current.restart(); });
    expect(actions.startModelChecks).toHaveBeenCalledWith("conn-openai", "cred-primary");
    expect(result.current.interrupted).toBeNull();
  });
});

describe("AdminProviderCheckBanner", () => {
  it("shows a retry for empty checks and partial Search setup, and reports the chosen defaults", () => {
    const restart = vi.fn(async () => true);
    const checks = { dismissInterrupted: vi.fn(), interrupted: null, restart, stop: vi.fn(async () => true),
      run: fixtureCheckRun({ id: "run", credentialId: "cred-primary", state: "completed", total: 0 }) };
    const view = render(<AdminProviderCheckBanner checks={checks} connection={workingConnection()} disabled={false} />);
    expect(screen.getByText("No models were checked.")).toBeVisible();
    expect(screen.queryByText(/all.*checked/iu)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    expect(restart).toHaveBeenCalledOnce();
    view.rerender(<AdminProviderCheckBanner checks={{ ...checks, run: { ...checks.run, done: 2, total: 2,
      setup: { state: "partial", search: "failed", defaults: ["Chat: GPT-6 Astra"] } } }} connection={workingConnection()} disabled={false} />);
    expect(screen.getByText(/Search could not be verified/u)).toBeVisible();
    expect(screen.getByText(/Chat: GPT-6 Astra/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry setup" })).toBeEnabled();
  });

  it("shows the KeyVerifying progress with Stop checking, and the interrupted state with Restart", async () => {
    const stop = vi.fn(async () => true);
    const restart = vi.fn(async () => true);
    const dismissInterrupted = vi.fn();
    const connection = workingConnection();
    const run = fixtureCheckRun({ credentialId: "cred-primary", current: "model-luna", done: 3, id: "run-1", inFlight: ["model-luna"], total: 4 });
    const view = render(
      <AdminProviderCheckBanner
        checks={{ dismissInterrupted, interrupted: null, restart, run, stop }}
        connection={connection}
        disabled={false}
      />
    );
    const banner = screen.getByTestId("provider-check-banner");
    expect(banner).toHaveTextContent("Key Primary saved. Checking what each model can do — 3 of 4 done.");
    expect(banner).toHaveTextContent("Checks supported capabilities, including tools, JSON, PDF, embeddings and reranking. You can leave this page.");
    expect(screen.getByRole("progressbar", { name: "Models checked" })).toHaveAttribute("aria-valuenow", "3");
    fireEvent.click(screen.getByRole("button", { name: "Stop checking" }));
    await waitFor(() => expect(stop).toHaveBeenCalledOnce());

    view.rerender(
      <AdminProviderCheckBanner
        checks={{ dismissInterrupted, interrupted: null, restart, run: { ...run, reason: "requested" }, stop }}
        connection={connection}
        disabled={false}
      />
    );
    expect(screen.getByTestId("provider-check-banner")).toHaveTextContent("Checking what each model can do with key Primary — 3 of 4 done.");

    view.rerender(
      <AdminProviderCheckBanner
        checks={{ dismissInterrupted, interrupted: null, restart, run: { ...run, reason: "model", total: 1 }, stop }}
        connection={connection}
        disabled={false}
      />
    );
    expect(screen.queryByTestId("provider-check-banner")).not.toBeInTheDocument();

    view.rerender(
      <AdminProviderCheckBanner
        checks={{ dismissInterrupted, interrupted: { credentialId: "cred-primary", id: "run-1" }, restart, run: null, stop }}
        connection={connection}
        disabled={false}
      />
    );
    expect(screen.getByTestId("provider-check-interrupted")).toHaveTextContent("Checking was interrupted before it finished.");
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(restart).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissInterrupted).toHaveBeenCalledOnce();
  });
});
