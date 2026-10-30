// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeRunControllerRegistry as registry } from "./activeRunControllerRegistry";
import {
  createWorkspaceFollowupCoordinator, WORKSPACE_FOLLOWUP_BUSY_RETRY_MS, type WorkspaceFollowupCoordinatorDependencies, type WorkspaceFollowupLoaded
} from "./workspaceFollowupCoordinator";
import { WorkspaceRunConflictError } from "./runRepositoryContract";
import { WorkspaceFollowupError } from "./workspaceFollowupPersistence";

function fixture() {
  const claim = { runId: "waiting-test-run", userId: "waiting-test-user", claimToken: "claim-token" };
  const loaded = { deadlineAt: new Date(Date.now() + 60_000), predecessor: { errorPayload: null, status: "complete" },
    modelRun: { workspaceWaitPending: true, status: "preparing" } } as WorkspaceFollowupLoaded;
  const deps: WorkspaceFollowupCoordinatorDependencies = {
    registry, continueRun: vi.fn(async () => undefined), fail: vi.fn(async () => undefined),
    repository: {
      claim: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
      load: vi.fn(async () => loaded), hasPending: vi.fn(async () => false),
      heartbeat: vi.fn(async () => true), release: vi.fn(async () => undefined),
      markAnswerDispatched: vi.fn(async () => true)
    }
  };
  return { claim, coordinator: createWorkspaceFollowupCoordinator(deps), deps, loaded };
}

afterEach(() => {
  for (const id of registry.ids()) if (id.startsWith("waiting-test-")) registry.abort(id);
  vi.useRealTimers();
});

describe("Workspace follow-up coordinator", () => {
  it("continues a durable successor only once and transfers controller ownership", async () => {
    const { claim, coordinator, deps } = fixture();
    vi.mocked(deps.continueRun).mockImplementation(async ({ releaseRegistry }) => {
      expect(registry.has(claim.runId)).toBe(true);
      releaseRegistry();
      expect(registry.has(claim.runId)).toBe(false);
    });
    expect(await coordinator.runOne()).toBe(true);
    expect(await coordinator.runOne()).toBe(false);
    expect(deps.continueRun).toHaveBeenCalledOnce();
    expect(deps.fail).not.toHaveBeenCalled();
    expect(deps.repository.release).toHaveBeenCalledWith(claim);
  });

  it.each(["expired", "failed predecessor"] as const)("settles %s without starting the next answer", async (reason) => {
    const { claim, coordinator, deps, loaded } = fixture();
    vi.mocked(deps.repository.load).mockResolvedValue({ ...loaded,
      ...(reason === "expired" ? { deadlineAt: new Date(0) } : { predecessor: { errorPayload: null, status: "error" } }) });
    await coordinator.runOne();
    expect(deps.continueRun).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith(claim, expect.objectContaining({ code: reason === "expired"
      ? "workspace_followup_expired" : "workspace_followup_predecessor_failed" }));
    expect(registry.has(claim.runId)).toBe(false);
  });

  it("continues after a predecessor whose Workspace disk was proven lost, never after another failure", async () => {
    const lost = fixture();
    vi.mocked(lost.deps.repository.load).mockResolvedValue({ ...lost.loaded,
      predecessor: { errorPayload: { code: "workspace_session_lost", message: "lost" }, status: "error" } });
    await lost.coordinator.runOne();
    expect(lost.deps.continueRun).toHaveBeenCalledOnce();
    expect(lost.deps.fail).not.toHaveBeenCalled();

    const exported = fixture();
    vi.mocked(exported.deps.repository.load).mockResolvedValue({ ...exported.loaded,
      predecessor: { errorPayload: { code: "workspace_output_export_failed", message: "failed" }, status: "error" } });
    await exported.coordinator.runOne();
    expect(exported.deps.continueRun).not.toHaveBeenCalled();
    expect(exported.deps.fail).toHaveBeenCalledWith(exported.claim, expect.objectContaining({ code: "workspace_followup_predecessor_failed" }));
  });

  it("tries an activation again while the chat's Workspace operation settles, never failing the accepted message", async () => {
    vi.useFakeTimers();
    const { claim, coordinator, deps } = fixture();
    vi.mocked(deps.repository.claim).mockReset().mockResolvedValueOnce(claim).mockResolvedValueOnce(claim).mockResolvedValue(null);
    // The last background run is leaving: its closing operation refuses the successor's reservation once.
    vi.mocked(deps.continueRun).mockRejectedValueOnce(new WorkspaceRunConflictError("workspace_busy", "workspace_busy_join_closing"))
      .mockResolvedValueOnce(undefined);
    const first = coordinator.runOne();
    await vi.advanceTimersByTimeAsync(WORKSPACE_FOLLOWUP_BUSY_RETRY_MS);
    expect(await first).toBe(true);
    expect(deps.fail).not.toHaveBeenCalled();
    expect(deps.repository.release).toHaveBeenCalledWith(claim);
    // Released, it is claimed again and activates.
    expect(await coordinator.runOne()).toBe(true);
    expect(deps.continueRun).toHaveBeenCalledTimes(2);
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it("fails a successor whose Workspace refuses for good, such as a failed session", async () => {
    const { claim, coordinator, deps } = fixture();
    vi.mocked(deps.continueRun).mockRejectedValueOnce(new WorkspaceRunConflictError("workspace_busy", "workspace_busy_session_failed"));
    await coordinator.runOne();
    expect(deps.fail).toHaveBeenCalledWith(claim, expect.objectContaining({ code: "workspace_followup_interrupted" }));
  });

  it("leaves explicit Stop to the cancellation writer", async () => {
    const { claim, coordinator, deps } = fixture();
    let started!: () => void;
    const entering = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(deps.continueRun).mockImplementation(({ signal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started();
    }));
    const running = coordinator.runOne();
    await entering;
    registry.abort(claim.runId);
    await running;
    expect(deps.fail).not.toHaveBeenCalled();
    expect(deps.repository.release).toHaveBeenCalledWith(claim);
  });

  it("stops on lease loss without a stale failure write", async () => {
    vi.useFakeTimers();
    const { coordinator, deps } = fixture();
    vi.mocked(deps.repository.heartbeat).mockResolvedValue(false);
    vi.mocked(deps.continueRun).mockImplementation(({ signal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const running = coordinator.runOne();
    await vi.advanceTimersByTimeAsync(10_000);
    await running;
    expect(deps.repository.heartbeat).toHaveBeenCalledOnce();
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it("resumes after the predecessor releases without another browser request", async () => {
    vi.useFakeTimers();
    const { claim, coordinator, deps } = fixture();
    let waiting = true;
    let eligible = false;
    vi.mocked(deps.repository.claim).mockReset().mockImplementation(async () => {
      if (!eligible || !waiting) return null;
      waiting = false;
      return claim;
    });
    vi.mocked(deps.repository.hasPending).mockImplementation(async () => waiting);
    coordinator.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.continueRun).not.toHaveBeenCalled();
    eligible = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(deps.continueRun).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);
    expect(deps.continueRun).toHaveBeenCalledOnce();
  });

  it("does not reuse a local live controller after claim contention", async () => {
    const { claim, coordinator, deps } = fixture();
    const existing = registry.register(claim.runId)!;
    await coordinator.runOne();
    expect(deps.repository.claim).toHaveBeenCalledWith(expect.any(Date), [claim.runId]);
    expect(deps.continueRun).not.toHaveBeenCalled();
    expect(deps.fail).not.toHaveBeenCalled();
    expect(registry.has(claim.runId)).toBe(true);
    existing.release();
  });

  it("retains a classified failure and releases the claim when preparation fails", async () => {
    const { claim, coordinator, deps } = fixture();
    vi.mocked(deps.continueRun).mockRejectedValue(new WorkspaceFollowupError("workspace_followup_invalid"));
    await coordinator.runOne();
    expect(deps.fail).toHaveBeenCalledWith(claim, expect.objectContaining({ code: "workspace_followup_invalid" }));
    expect(deps.repository.release).toHaveBeenCalledOnce();
    expect(registry.has(claim.runId)).toBe(false);
  });
});
