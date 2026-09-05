import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  adminKnowledgeAnswerPolicyFixture,
  adminKnowledgeOperationsFixture,
  adminKnowledgeProfileFixture
} from "@/tests/support/knowledgeProfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminKnowledgeSection } from "./AdminKnowledgeSection";

const settings = {
  answerPolicy: adminKnowledgeAnswerPolicyFixture(),
  ingestionLimits: {
    maxChunksPerDocument: 10_000,
    maxFileBytes: 25_000_000,
    maxNormalizedChars: 5_000_000,
    maxPages: 2_000
  },
  operations: adminKnowledgeOperationsFixture(),
  profile: adminKnowledgeProfileFixture(),
  retrieval: {
    candidateLimit: 40 as const,
    resultLimit: 16 as const
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("administrator Knowledge section", () => {
  it("shows one privacy-neutral answer retrieval control and read-only ingestion facts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ knowledge: settings }), { status: 200 })
    ));

    render(<AdminKnowledgeSection active />);

    expect(await screen.findByText("25 MB")).toBeVisible();
    expect(screen.getByText(/never lists private bases/i)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Answer retrieval" })).toBeVisible();
    expect(screen.getByRole("spinbutton", {
      name: /Maximum Knowledge searches per answer/
    })).toHaveValue(12);
    expect(screen.getByRole("spinbutton", {
      name: /Parallel document processing/
    })).toHaveValue(8);
    for (const save of screen.getAllByRole("button", { name: "Save" })) {
      expect(save).toBeDisabled();
    }
    expect(screen.queryByLabelText(/candidate passages/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Hybrid candidates")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/visual-analysis destination/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Operations health" })).toBeVisible();
    expect(screen.getByText("No active alerts")).toBeVisible();
    expect(screen.getByText(/V1 reconciliation · clean/)).toBeVisible();
    const operations = screen.getByRole("heading", { name: "Operations health" })
      .closest("section");
    expect(operations).not.toBeNull();
    expect(within(operations!).getByText("Search index")).toBeVisible();
    expect(within(operations!).getByText("0 / 0")).toBeVisible();
    expect(within(operations!).getByText(
      "Search backend available · Worker healthy"
    )).toBeVisible();
  });

  it("shows actionable aggregate alerts without exposing internal codes", async () => {
    const alertSettings = {
      ...settings,
      operations: adminKnowledgeOperationsFixture({
        alerts: [{
          code: "knowledge_v1_reconciliation_incomplete",
          severity: "critical"
        }],
        migration: {
          discrepancies: 2,
          mappedArtifacts: 1,
          mappedDocuments: 1,
          mappedVersions: 1,
          v1Artifacts: 2,
          v1Documents: 2,
          v1Versions: 2
        }
      })
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ knowledge: alertSettings }), { status: 200 })
    ));

    render(<AdminKnowledgeSection active />);

    expect(await screen.findByText("1 active alert")).toBeVisible();
    expect(screen.getByText("Legacy Knowledge reconciliation is incomplete.")).toBeVisible();
    expect(screen.queryByText("knowledge_v1_reconciliation_incomplete")).not.toBeInTheDocument();
  });

  it("shows aggregate search faults without exposing infrastructure details", async () => {
    const alertSettings = {
      ...settings,
      operations: adminKnowledgeOperationsFixture({
        alerts: [
          { code: "knowledge_search_backend_unavailable", severity: "critical" },
          { code: "knowledge_search_projection_backlog", severity: "warning" },
          { code: "knowledge_search_projection_failures", severity: "critical" },
          { code: "knowledge_search_worker_unavailable", severity: "critical" }
        ],
        search: {
          backendState: "unavailable",
          expectedProjections: 4,
          failedProjections: 1,
          pendingProjections: 1,
          readyProjections: 2,
          workerLastSeenAt: "2026-08-17T23:50:00.000Z",
          workerState: "stale"
        }
      })
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ knowledge: alertSettings }), { status: 200 })
    ));

    render(<AdminKnowledgeSection active />);

    expect(await screen.findByText("4 active alerts")).toBeVisible();
    expect(screen.getByText("The Knowledge search index is unavailable.")).toBeVisible();
    expect(screen.getByText(
      "Knowledge search projections are waiting to be indexed."
    )).toBeVisible();
    expect(screen.getByText(
      "One or more Knowledge search projections need administrator action."
    )).toBeVisible();
    expect(screen.getByText(
      "The Knowledge search worker heartbeat is missing or stale."
    )).toBeVisible();
    expect(screen.getByText("2 / 4")).toBeVisible();
    expect(screen.getByText("Search backend unavailable · Worker stale")).toBeVisible();
    expect(document.body.textContent).not.toMatch(
      /knowledge_search_|endpoint|instanceId|opensearch|private-search/iu
    );
  });

  it("saves a bounded parallel document processing width for future work", async () => {
    const onMutationCommitted = vi.fn();
    const saved = {
      ...settings,
      answerPolicy: adminKnowledgeAnswerPolicyFixture({
        ingestionParallelism: 12,
        version: 2
      })
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ knowledge: settings }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ knowledge: saved }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    render(<AdminKnowledgeSection active onMutationCommitted={onMutationCommitted} />);

    const parallelism = await screen.findByRole("spinbutton", {
      name: /Parallel document processing/
    });
    expect(screen.getByText(/Applies only to future background processing/)).toBeVisible();
    const row = screen.getByTestId("knowledge-ingestion-parallelism-row");
    fireEvent.change(parallelism, { target: { value: "12" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));

    await screen.findByText(
      "Document processing settings saved. Future background processing uses the updated limit."
    );
    expect(parallelism).toHaveValue(12);
    const [, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      action: "update_ingestion_parallelism",
      expectedVersion: 1,
      ingestionParallelism: 12
    });
    expect(onMutationCommitted).toHaveBeenCalledOnce();
  });

  it("keeps an out-of-range or cleared parallelism unsendable and surfaces conflicts", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ knowledge: settings }), { status: 200 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: "knowledge_ingestion_parallelism_stale" }),
        { status: 409 }
      ));
    vi.stubGlobal("fetch", fetcher);

    render(<AdminKnowledgeSection active />);

    const parallelism = await screen.findByRole("spinbutton", {
      name: /Parallel document processing/
    });
    const row = screen.getByTestId("knowledge-ingestion-parallelism-row");
    const save = within(row).getByRole("button", { name: "Save" });

    fireEvent.change(parallelism, { target: { value: "65" } });
    expect(save).toBeDisabled();
    fireEvent.change(parallelism, { target: { value: "" } });
    expect(save).toBeDisabled();
    fireEvent.change(parallelism, { target: { value: "4" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Document processing settings changed elsewhere. Refresh and try again."
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("shows assignments read-only and links to the sole System Models editor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ knowledge: settings }))));
    render(<AdminKnowledgeSection active />);
    expect(await screen.findByTestId("knowledge-profile-route")).toHaveTextContent("Local embeddings / Multilingual embed");
    expect(screen.getByRole("link", { name: "Manage assignments in System Models" }))
      .toHaveAttribute("href", "/admin?section=system-models");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Activate|Restore profile/ })).not.toBeInTheDocument();
  });
});
