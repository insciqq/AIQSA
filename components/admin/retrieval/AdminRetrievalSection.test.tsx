import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { adminKnowledgeOperationsFixture, adminKnowledgeSettingsFixture } from "@/tests/support/knowledgeProfile";
import type { AdminKnowledgeSettings } from "@/lib/contracts/adminKnowledge";
import type { AdminMemoryStatus } from "@/lib/contracts/adminMemory";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminConfirmationRequest } from "../useAdminConfirmationController";
import { AdminRetrievalSection } from "./AdminRetrievalSection";

function memoryStatus(overrides: Partial<AdminMemoryStatus> = {}): AdminMemoryStatus {
  return {
    activeIssueCode: null,
    admissionTimeout: { seconds: 15, version: 4 },
    configuredTargets: [{ model: "GPT Luna", provider: "OpenAI" }],
    index: { generation: 4, readiness: "READY" },
    queue: { length: 0, oldestAgeSeconds: null },
    rebuild: { state: "NOT_REQUIRED" },
    worker: { state: "RUNNING" },
    ...overrides
  };
}

type Call = { body: Record<string, unknown> | null; method: string; url: string };

function server(initial: Readonly<{ knowledge?: AdminKnowledgeSettings; memory?: AdminMemoryStatus }> = {}) {
  let knowledge = initial.knowledge ?? adminKnowledgeSettingsFixture();
  let memory = initial.memory ?? memoryStatus();
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ body, method, url });
    if (url === "/api/admin/knowledge") {
      if (method === "PATCH" && body) {
        if (body.expectedVersion !== knowledge.answerPolicy.version) {
          return Response.json({ error: "knowledge_answer_policy_stale" }, { status: 409 });
        }
        knowledge = adminKnowledgeSettingsFixture({ ...knowledge, answerPolicy: {
          ...knowledge.answerPolicy, version: knowledge.answerPolicy.version + 1,
          ...(body.action === "update_answer_policy" ? { maximumKnowledgeSearches: Number(body.maximumKnowledgeSearches) } : {}),
          ...(body.action === "update_ingestion_parallelism" ? { ingestionParallelism: Number(body.ingestionParallelism) } : {})
        } });
      }
      return Response.json({ knowledge });
    }
    if (url === "/api/admin/memory") {
      if (method === "PUT" && body) {
        memory = { ...memory, admissionTimeout: { seconds: Number(body.timeoutSeconds), version: memory.admissionTimeout.version + 1 } };
      }
      if (method === "POST") {
        memory = memoryStatus({
          activeIssueCode: null, index: { generation: 5, readiness: "REBUILDING" },
          queue: { length: 1, oldestAgeSeconds: 0 }, rebuild: { state: "IN_PROGRESS" }
        });
      }
      return Response.json({ memory });
    }
    return Response.json({ error: "unexpected_request" }, { status: 500 });
  }));
  return calls;
}

function renderSection() {
  const onOpenRoles = vi.fn();
  const reportNotice = vi.fn();
  const requestConfirmation = vi.fn<(config: AdminConfirmationRequest) => void>();
  const onMutationCommitted = vi.fn();
  render(
    <AdminRetrievalSection
      onMutationCommitted={onMutationCommitted}
      onOpenRoles={onOpenRoles}
      reportNotice={reportNotice}
      requestConfirmation={requestConfirmation}
    />
  );
  return { onMutationCommitted, onOpenRoles, reportNotice, requestConfirmation };
}

afterEach(() => vi.unstubAllGlobals());

describe("AdminRetrievalSection", () => {
  it("shows one processing line, alerts and metrics, and links assignments to Defaults & roles", async () => {
    server({ knowledge: adminKnowledgeSettingsFixture({ operations: adminKnowledgeOperationsFixture({
      alerts: [{ code: "knowledge_search_worker_unavailable", severity: "warning" }],
      search: { backendState: "available", expectedProjections: 3, failedProjections: 0, pendingProjections: 1, readyProjections: 2, workerLastSeenAt: "2026-08-18T00:00:00.000Z", workerState: "stale" }
    }) }) });
    const { onOpenRoles } = renderSection();
    const knowledge = await screen.findByTestId("admin-retrieval-knowledge");
    expect(within(knowledge).getByTestId("knowledge-processing-state")).toHaveTextContent("Ready");
    expect(within(knowledge).getByTestId("knowledge-processing-line"))
      .toHaveTextContent("Documents: Local · no model · Embeddings: Local embeddings / Multilingual embed · 1024d");
    expect(within(knowledge).getByRole("list", { name: "Knowledge alerts" }))
      .toHaveTextContent("The Knowledge search worker heartbeat is missing or stale.");
    expect(within(knowledge).getByText("2 / 3")).toBeInTheDocument();
    expect(within(knowledge).getByText("Search backend available · Worker stale")).toBeInTheDocument();
    expect(within(knowledge).queryByText(/Manage assignments|revision|Normalized text/)).not.toBeInTheDocument();
    fireEvent.click(within(knowledge).getByRole("button", { name: "Processing model and embeddings: Defaults & roles" }));
    expect(onOpenRoles).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("admin-retrieval-memory")).toHaveTextContent("Memory");
  });

  it("saves both Knowledge limits with one Save as chained requests", async () => {
    const calls = server();
    const { onMutationCommitted, reportNotice } = renderSection();
    const searches = await screen.findByRole("spinbutton", { name: /Maximum Knowledge searches per answer/ });
    const parallelism = screen.getByRole("spinbutton", { name: /Parallel document processing/ });
    const knowledge = screen.getByTestId("admin-retrieval-knowledge");
    const save = within(knowledge).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(searches, { target: { value: "18" } });
    fireEvent.change(parallelism, { target: { value: "16" } });
    fireEvent.click(save);
    await waitFor(() => expect(reportNotice).toHaveBeenCalledWith(expect.stringMatching(/Knowledge limits saved/)));
    expect(calls.filter((call) => call.url === "/api/admin/knowledge" && call.method === "PATCH").map((call) => call.body)).toEqual([
      { action: "update_answer_policy", expectedVersion: 1, maximumKnowledgeSearches: 18 },
      { action: "update_ingestion_parallelism", expectedVersion: 2, ingestionParallelism: 16 }
    ]);
    expect(onMutationCommitted).toHaveBeenCalledTimes(1);
    expect(save).toBeDisabled();
    expect(searches).toHaveValue(18);
  });

  it("saves the Memory admission timeout and confirms before a rebuild", async () => {
    const calls = server({ memory: memoryStatus({ index: { generation: 4, readiness: "REBUILD_REQUIRED" }, rebuild: { state: "AVAILABLE" } }) });
    const { reportNotice, requestConfirmation } = renderSection();
    const memory = await screen.findByTestId("admin-retrieval-memory");
    expect(within(memory).getByTestId("memory-state")).toHaveTextContent("Rebuild required");
    expect(within(memory).getByText("Rebuild required", { selector: "dd" })).toBeInTheDocument();
    expect(within(memory).queryByText(/Generation|fingerprint|System Models/)).not.toBeInTheDocument();
    const timeout = within(memory).getByRole("spinbutton", { name: "Admission timeout (seconds)" });
    expect(timeout).toHaveValue(15);
    fireEvent.change(timeout, { target: { value: "30" } });
    fireEvent.click(within(memory).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(reportNotice).toHaveBeenCalledWith(expect.stringMatching(/timeout saved/)));
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

  it("keeps a stale limit save inline and leaves the field editable", async () => {
    server({ knowledge: adminKnowledgeSettingsFixture({ answerPolicy: { ...adminKnowledgeSettingsFixture().answerPolicy, version: 9 } }) });
    renderSection();
    const searches = await screen.findByRole("spinbutton", { name: /Maximum Knowledge searches per answer/ });
    fireEvent.change(searches, { target: { value: "20" } });
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return Response.json({ error: "knowledge_answer_policy_stale" }, { status: 409 });
      return original(input, init);
    }));
    fireEvent.click(within(screen.getByTestId("admin-retrieval-knowledge")).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed elsewhere/);
    expect(searches).toHaveValue(20);
  });
});
