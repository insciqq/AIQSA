import { memoryRecoveryStatusFixture, memoryWorkerStatusFixture } from "@/tests/support/memoryStatus";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AdminMemoryStatus } from "@/lib/contracts/adminMemory";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminConfirmationRequest } from "../useAdminConfirmationController";
import { AdminRetrievalSection } from "./AdminRetrievalSection";

function memoryStatus(overrides: Partial<AdminMemoryStatus> = {}): AdminMemoryStatus {
  return {
    processing: { enabled: true, issues: [] },
    searchTimeout: { seconds: 15, version: 4 },
    configuredTargets: [{ model: "GPT Luna", provider: "OpenAI" }],
    index: { generation: 4, readiness: "READY" },
    queue: { inProgress: 0, length: 0, oldestAgeSeconds: null },
    rebuild: { state: "NOT_REQUIRED" },
    recovery: memoryRecoveryStatusFixture(),
    worker: memoryWorkerStatusFixture(),
    ...overrides
  };
}

type Call = { body: Record<string, unknown> | null; method: string; url: string };

function server(initial: Readonly<{ memory?: AdminMemoryStatus }> = {}) {
  let memory = initial.memory ?? memoryStatus();
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ body, method, url });
    if (url === "/api/admin/memory") {
      if (method === "PUT" && body) {
        memory = { ...memory, searchTimeout: { seconds: Number(body.timeoutSeconds), version: memory.searchTimeout.version + 1 } };
      }
      if (method === "POST" && body?.action === "RECOVER_ELIGIBLE") {
        memory = { ...memory, recovery: memoryRecoveryStatusFixture(),
          queue: { inProgress: 0, length: memory.recovery.eligible, oldestAgeSeconds: 0 } };
      } else if (method === "POST") {
        memory = memoryStatus({
          processing: { enabled: true, issues: [] }, index: { generation: 5, readiness: "REBUILDING" },
          queue: { inProgress: 0, length: 1, oldestAgeSeconds: 0 }, rebuild: { state: "IN_PROGRESS" }
        });
      }
      return Response.json({ memory });
    }
    return Response.json({ error: "unexpected_request" }, { status: 500 });
  }));
  return calls;
}

function renderSection() {
  const reportNotice = vi.fn();
  const requestConfirmation = vi.fn<(config: AdminConfirmationRequest) => void>();
  render(
    <AdminRetrievalSection
      reportNotice={reportNotice}
      requestConfirmation={requestConfirmation}
    />
  );
  return { reportNotice, requestConfirmation };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdminRetrievalSection", () => {
  it("shows only the Memory card and reads no Knowledge", async () => {
    const calls = server();
    renderSection();

    expect(await screen.findByTestId("admin-retrieval-memory")).toHaveTextContent("Memory");
    expect(screen.queryByTestId("admin-retrieval-knowledge")).toBeNull();
    expect(calls.filter((call) => call.url === "/api/admin/knowledge")).toEqual([]);
  });

  it("shows mixed history causes separately and updates each issue on refresh", async () => {
    const retrying = { stage: "HISTORY", reason: "RETRYING", severity: "warn",
      count: 1, oldestAgeSeconds: 1800 } as const;
    server({ memory: memoryStatus({ processing: { enabled: true, issues: [
      { stage: "HISTORY", reason: "PROCESSING_FAILED", severity: "bad", count: 1, oldestAgeSeconds: 300 }, retrying
    ] } }) });
    renderSection();
    await screen.findByText("Memory history processing failed");
    expect(screen.getByText("Memory history processing needs attention")).toBeInTheDocument();
    const memory = screen.getByTestId("admin-retrieval-memory");
    expect(memory).toHaveTextContent("1 affected job; oldest 5m");
    expect(memory).toHaveTextContent("1 affected job; oldest 30m");
    expect(memory).not.toHaveTextContent("2 affected jobs");
    expect(within(memory).getAllByRole("link", { name: "Open Memory" })).toHaveLength(2);
    server({ memory: memoryStatus({ processing: { enabled: true, issues: [retrying] } }) });
    fireEvent.click(screen.getByRole("button", { name: "Refresh Memory status" }));
    await waitFor(() => expect(screen.queryByText("Memory history processing failed")).not.toBeInTheDocument());
    expect(screen.getByText("Memory history processing needs attention")).toBeInTheDocument();
    server({ memory: memoryStatus() });
    fireEvent.click(screen.getByRole("button", { name: "Refresh Memory status" }));
    await waitFor(() => expect(screen.queryByText("Memory history processing needs attention")).not.toBeInTheDocument());
    expect(screen.getByTestId("memory-state")).toHaveTextContent("Working");
  });

  it("retries eligible work independently of rebuild and preserves an unsaved timeout", async () => {
    const calls = server({ memory: memoryStatus({ recovery: memoryRecoveryStatusFixture({ eligible: 2 }) }) });
    const { reportNotice, requestConfirmation } = renderSection();
    const retry = await screen.findByRole("button", { name: "Retry eligible work" });
    const field = screen.getByRole("spinbutton", { name: "Memory search time limit (seconds)" });
    fireEvent.change(field, { target: { value: "42" } });
    fireEvent.click(retry);
    await waitFor(() => expect(reportNotice).toHaveBeenCalledWith("Eligible Memory work was queued for retry."));
    expect(calls.filter(({ method }) => method === "POST").map(({ body }) => body)).toEqual([{ action: "RECOVER_ELIGIBLE" }]);
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(field).toHaveValue(42);
    expect(screen.getByTestId("admin-retrieval-memory")).toHaveTextContent("2 waiting");
  });

  it.each([
    [memoryWorkerStatusFixture({ state: "NOT_RUNNING", reason: "NOT_READY" }), "Worker not running"],
    [memoryWorkerStatusFixture({ state: "STALLED", reason: "QUEUE_STALLED", lastProgressAgeSeconds: 1200 }), "Queue stalled"],
    [memoryWorkerStatusFixture({ state: "STALLED", reason: "QUEUE_STALLED", lastProgressAgeSeconds: 1 }), "Queue stalled"]
  ] as const)("distinguishes stopped startup and a live stalled queue with recovery evidence", async (worker, label) => {
    server({ memory: memoryStatus({ worker, recovery: memoryRecoveryStatusFixture({ eligible: 1, protected: 2, permanent: 3 }) }) });
    renderSection();
    await waitFor(() => expect(screen.getByTestId("memory-state")).toHaveTextContent(label));
    const retry = screen.getByRole("button", { name: "Retry eligible work" });
    if (worker.state === "NOT_RUNNING") expect(retry).toBeDisabled();
    else expect(retry).toBeEnabled();
    expect(screen.getByTestId("admin-retrieval-memory")).toHaveTextContent("2 have a recorded provider execution");
    expect(screen.getByTestId("admin-retrieval-memory")).toHaveTextContent("3 require a fix before retry");
    if (worker.state === "STALLED" && worker.lastProgressAgeSeconds === 1) {
      expect(screen.getByTestId("admin-retrieval-memory")).toHaveTextContent("Some queued work is not progressing");
      expect(screen.getByTestId("admin-retrieval-memory")).not.toHaveTextContent("No queue progress for 1s");
    }
  });

  it("disables recovery after a failed refresh while keeping the last known evidence", async () => {
    const calls = server({ memory: memoryStatus({ recovery: memoryRecoveryStatusFixture({ eligible: 2 }) }) });
    renderSection();
    const retry = await screen.findByRole("button", { name: "Retry eligible work" });
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/api/admin/memory" ? Response.json({ error: "memory_admin_status_failed" }, { status: 503 }) : original(input, init)));
    fireEvent.click(screen.getByRole("button", { name: "Refresh Memory status" }));
    await waitFor(() => expect(screen.getByTestId("memory-state")).toHaveTextContent("Status unknown"));
    expect(retry).toBeDisabled();
    expect(screen.getByTestId("admin-retrieval-memory")).toHaveTextContent("2 eligible for retry");
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(0);
  });

  it.each([
    [{ inProgress: 2, length: 3, oldestAgeSeconds: 75 }, "2 in progress · 3 waiting · oldest 1m"],
    [{ inProgress: 1, length: 0, oldestAgeSeconds: null }, "1 in progress · 0 waiting"]
  ] as const)("distinguishes in-flight work from the waiting backlog", async (queue, copy) => {
    server({ memory: memoryStatus({ queue }) });
    renderSection();
    const memory = await screen.findByTestId("admin-retrieval-memory");
    await waitFor(() => expect(memory).toHaveTextContent(copy));
    expect(memory).not.toHaveTextContent("Not running");
    expect(memory).not.toHaveTextContent("Empty");
  });

  it("shows stopped learning ahead of a live worker and ready index with an actionable reason", async () => {
    server({ memory: memoryStatus({ processing: { enabled: true, issues: [{
      stage: "LEARNING", reason: "CAPABILITY_UNAVAILABLE", severity: "bad", count: 3, oldestAgeSeconds: 1865
    }] } }) });
    renderSection();
    const memory = await screen.findByTestId("admin-retrieval-memory");
    await waitFor(() => expect(within(memory).getByTestId("memory-state")).toHaveTextContent("Processing blocked"));
    expect(within(memory).getByText("Ready", { exact: true })).toBeInTheDocument();
    expect(within(memory).getByText("Running", { exact: true })).toBeInTheDocument();
    expect(memory).toHaveTextContent("3 affected jobs; oldest 31m");
    expect(memory).toHaveTextContent("required verified capability");
    expect(within(memory).getByRole("link", { name: "Open Defaults & roles" })).toHaveAttribute("href", "/admin?section=roles&resource=memory");
    expect(memory).not.toHaveTextContent(/consent|memory_execution_/u);
  });
  it("lists recent command and search failures as warnings without reading as blocked processing", async () => {
    server({ memory: memoryStatus({ processing: { enabled: true, issues: [
      { stage: "COMMAND", reason: "COMMAND_FAILED", severity: "warn", count: 2, oldestAgeSeconds: 7200 },
      { stage: "SEARCH", reason: "SEARCH_FAILED", severity: "warn", count: 1, oldestAgeSeconds: 600 }
    ] } }) });
    renderSection();
    const memory = await screen.findByTestId("admin-retrieval-memory");
    await waitFor(() => expect(within(memory).getByTestId("memory-state")).toHaveTextContent("Working"));
    expect(memory).toHaveTextContent("Memory commands failed recently");
    expect(memory).toHaveTextContent("2 commands; oldest 2h");
    expect(memory).toHaveTextContent("Memory search degraded recently");
    expect(memory).toHaveTextContent("1 search; oldest 10m");
    expect(memory).not.toHaveTextContent(/Processing blocked|Processing delayed/u);
  });
  it("saves the Memory search time limit and confirms before a rebuild", async () => {
    const calls = server({ memory: memoryStatus({ index: { generation: 4, readiness: "REBUILD_REQUIRED" }, rebuild: { state: "AVAILABLE" } }) });
    const { reportNotice, requestConfirmation } = renderSection();
    const memory = await screen.findByTestId("admin-retrieval-memory");
    expect(within(memory).getByTestId("memory-state")).toHaveTextContent("Rebuild required");
    expect(within(memory).getByText("Rebuild required", { selector: "dd" })).toBeInTheDocument();
    expect(within(memory).queryByText(/Generation|fingerprint|System Models/)).not.toBeInTheDocument();
    const timeout = within(memory).getByRole("spinbutton", { name: "Memory search time limit (seconds)" });
    expect(memory).toHaveTextContent("Applies to each Memory search requested by the answer.");
    expect(memory).toHaveTextContent("Local standing facts use a separate fixed limit.");
    expect(timeout).toHaveValue(15);
    fireEvent.change(timeout, { target: { value: "30" } });
    fireEvent.click(within(memory).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(reportNotice).toHaveBeenCalledWith(
      "Memory search time limit saved. New answers use the updated limit."
    ));
    expect(calls.filter((call) => call.method === "PUT").map((call) => call.body)).toEqual([{ expectedVersion: 4, timeoutSeconds: 30 }]);

    fireEvent.click(within(memory).getByRole("button", { name: "Rebuild" }));
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    const config = requestConfirmation.mock.calls[0]![0];
    expect(config.title).toBe("Rebuild the Memory index?");
    await config.onConfirm();
    await waitFor(() => expect(within(memory).getByText(/rebuild is in progress/)).toBeInTheDocument());
    expect(calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([{ action: "REBUILD_REQUIRED" }]);
    expect(within(memory).queryByRole("button", { name: "Rebuild" })).not.toBeInTheDocument();
    expect(within(memory).getByTestId("memory-state")).toHaveTextContent("Rebuilding");
  });
});
