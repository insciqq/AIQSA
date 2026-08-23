import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  KnowledgeCitationControl,
  KnowledgeCitationViewerProvider,
  useKnowledgeSourceViewer
} from "./KnowledgeCitationViewer";

const shellFetch = vi.hoisted(() => vi.fn());

vi.mock("@/components/app-shell/shellApi", () => ({ shellFetch }));

function citation() {
  return {
    blocks: [{
      boundingBoxes: [{
        bottom: 120,
        coordinateOrigin: "top_left",
        left: 30,
        page: 18,
        right: 260,
        top: 80
      }],
      headingPath: ["Policy", "Limits"],
      pageEnd: 18,
      pageStart: 18,
      relation: "target",
      table: {
        cells: [{ column: 0, columnSpan: 1, row: 0, rowSpan: 1, text: "25 MB" }],
        columnCount: 1,
        rowCount: 1,
        truncated: false
      },
      text: "Maximum file size: 25 MB.",
      type: "table"
    }],
    excerpt: "Maximum file size: 25 MB.",
    excerptTruncated: false,
    handle: "K1",
    headingPath: ["Policy", "Limits"],
    locator: {
      boundingBoxes: [{
        bottom: 120,
        coordinateOrigin: "top_left",
        left: 30,
        page: 18,
        right: 260,
        top: 80
      }],
      pageEnd: 18,
      pageStart: 18
    },
    originalKind: "pdf",
    source: {
      baseName: "Engineering handbook",
      fileName: "policy.pdf",
      mimeType: "application/pdf",
      name: "Upload policy",
      statuses: ["earlier_version", "removed"],
      versionNumber: 1
    },
    state: "available",
    visual: null,
    workbook: null
  };
}

function structuredCitation() {
  return {
    ...citation(),
    blocks: [],
    excerpt: "Calculated sum Revenue: 300.",
    headingPath: ["Sales"],
    locator: { boundingBoxes: [], pageEnd: 1, pageStart: 1 },
    originalKind: null,
    source: {
      ...citation().source,
      fileName: "sales.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      name: "Quarterly sales",
      statuses: []
    },
    workbook: {
      operationSummary: "Summed Revenue over 2 matching rows.",
      ranges: [{
        cells: [
          {
            address: "B2",
            column: 1,
            display: "100",
            formula: null,
            row: 1,
            type: "number",
            value: 100
          },
          {
            address: "B3",
            column: 1,
            display: "200",
            formula: "B2*2",
            row: 2,
            type: "number",
            value: 200
          }
        ],
        range: "B2:B3",
        role: "value",
        sheet: "Sales",
        sheetIndex: 0,
        truncated: false
      }],
      result: { columns: ["sum Revenue"], rows: [[300]] },
      warnings: ["Cached formula values were used."]
    }
  };
}

function visualCitation() {
  return {
    ...citation(),
    blocks: [{
      boundingBoxes: citation().locator.boundingBoxes,
      headingPath: ["Results"],
      pageEnd: 2,
      pageStart: 2,
      relation: "target",
      table: null,
      text: "",
      type: "image"
    }],
    excerpt: "Visual evidence: Quarterly revenue",
    headingPath: ["Results"],
    locator: { ...citation().locator, pageEnd: 2, pageStart: 2 },
    originalKind: "image",
    source: {
      ...citation().source,
      fileName: "chart.png",
      mimeType: "image/png",
      name: "Quarterly report",
      statuses: []
    },
    visual: {
      caption: "Quarterly revenue by region",
      description: "North increased while South remained flat.",
      kind: "chart",
      label: "Quarterly revenue",
      status: "available",
      warnings: []
    }
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

function SourceButton() {
  const open = useKnowledgeSourceViewer();
  return (
    <button onClick={(event) => open("source-1", event.currentTarget)} type="button">
      Preview source
    </button>
  );
}

describe("Knowledge citation viewer", () => {
  beforeEach(() => {
    shellFetch.mockReset();
  });

  it("loads a focus preview, opens the same responsive rail, and restores keyboard focus", async () => {
    shellFetch.mockImplementation(async () => jsonResponse({ citation: citation() }));
    render(
      <KnowledgeCitationViewerProvider>
        <p>
          Claim <KnowledgeCitationControl reference={{
            handle: "K1",
            messageId: "message-1",
            runId: "run-1"
          }} />
        </p>
      </KnowledgeCitationViewerProvider>
    );
    const trigger = screen.getByRole("button", { name: "Open source K1" });
    act(() => trigger.focus());
    const preview = await screen.findByRole("tooltip");
    expect(preview).toHaveTextContent("Engineering handbook · Page 18 · version 1");
    expect(preview).toHaveTextContent("Earlier accepted version");
    expect(preview).toHaveTextContent("Maximum file size: 25 MB.");
    expect(trigger).toHaveAttribute("aria-describedby", "knowledge-citation-preview");

    fireEvent.click(trigger);
    const rail = await screen.findByRole("dialog", { name: "Knowledge source viewer" });
    expect(rail).toHaveClass("w-full", "sm:max-w-[44rem]");
    expect(screen.getByText("Earlier accepted version · Removed from this base after the answer")).toBeVisible();
    expect(screen.getByRole("cell", { name: "25 MB" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Highlighted cited area on page 18" })).toHaveAttribute(
      "src",
      "/api/runs/run-1/messages/message-1/citations/K1?asset=page"
    );
    expect(screen.getByRole("link", { name: "Open page 18" })).toHaveAttribute(
      "href",
      "/api/runs/run-1/messages/message-1/citations/K1?asset=original#page=18"
    );
    expect(shellFetch).toHaveBeenLastCalledWith(
      "/api/runs/run-1/messages/message-1/citations/K1",
      expect.objectContaining({ method: "GET" })
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Close source viewer" })).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Knowledge source viewer" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("does not draw stored coordinates on a blank surrogate when the original is unavailable", async () => {
    shellFetch.mockImplementation(async () => jsonResponse({
      citation: { ...citation(), originalKind: null }
    }));
    render(
      <KnowledgeCitationViewerProvider>
        <KnowledgeCitationControl reference={{
          handle: "K1",
          messageId: "message-1",
          runId: "run-1"
        }} />
      </KnowledgeCitationViewerProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Open source K1" }));
    expect(await screen.findByText(/Original page preview is unavailable/u)).toBeVisible();
    expect(screen.queryByText(/Stored highlight coordinates/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Highlighted regions on page/u })).not.toBeInTheDocument();
  });

  it("falls back to the exact PDF page when highlighted rendering is unavailable", async () => {
    shellFetch.mockImplementation(async () => jsonResponse({ citation: citation() }));
    render(
      <KnowledgeCitationViewerProvider>
        <KnowledgeCitationControl reference={{
          handle: "K1",
          messageId: "message-1",
          runId: "run-1"
        }} />
      </KnowledgeCitationViewerProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Open source K1" }));
    const highlighted = await screen.findByRole("img", {
      name: "Highlighted cited area on page 18"
    });
    fireEvent.error(highlighted);
    expect(await screen.findByTitle("policy.pdf, page 18")).toHaveAttribute(
      "src",
      "/api/runs/run-1/messages/message-1/citations/K1?asset=original#page=18"
    );
  });

  it("keeps unavailable and deleted references privacy neutral", async () => {
    shellFetch.mockResolvedValueOnce(jsonResponse({
      error: "knowledge_reference_not_available",
      privateFileName: "must-not-leak.pdf"
    }, 404));
    const { rerender } = render(
      <KnowledgeCitationViewerProvider>
        <KnowledgeCitationControl reference={{
          handle: "K1",
          messageId: "message-1",
          runId: "run-1"
        }} />
      </KnowledgeCitationViewerProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Open source K1" }));
    expect((await screen.findAllByText("Source unavailable"))[0]).toBeVisible();
    expect(document.body).not.toHaveTextContent("must-not-leak.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Close source viewer" }));

    shellFetch.mockResolvedValueOnce(jsonResponse({
      citation: { handle: "K1", state: "deleted" }
    }));
    rerender(
      <KnowledgeCitationViewerProvider>
        <KnowledgeCitationControl reference={{
          handle: "K1",
          messageId: "message-1",
          runId: "run-1"
        }} />
      </KnowledgeCitationViewerProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Open source K1" }));
    expect(await screen.findByText("Deleted Knowledge source")).toBeVisible();
    expect(document.body).toHaveTextContent("No filename, passage, or locator is retained.");
  });

  it("shows the exact operation, result, and highlighted workbook ranges", async () => {
    shellFetch.mockImplementation(async () => jsonResponse({ citation: structuredCitation() }));
    render(
      <KnowledgeCitationViewerProvider>
        <KnowledgeCitationControl reference={{
          handle: "K1",
          messageId: "message-1",
          runId: "run-1"
        }} />
      </KnowledgeCitationViewerProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Open source K1" }));
    expect(await screen.findByTestId("knowledge-workbook-evidence")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Summed Revenue over 2 matching rows." })).toBeVisible();
    expect(screen.getByLabelText("Cited workbook ranges")).toHaveTextContent("Sales!B2:B3");
    expect(screen.getByRole("columnheader", { name: "sum Revenue" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "300" })).toBeVisible();
    expect(screen.getByRole("cell", { name: /200.*B2\*2/u })).toBeVisible();
    expect(screen.getByText("Cached formula values were used.")).toBeVisible();
    expect(screen.queryByText("Exact accepted excerpt")).not.toBeInTheDocument();
  });

  it("shows the original visual and caption before the bounded generated description", async () => {
    shellFetch.mockImplementation(async () => jsonResponse({ citation: visualCitation() }));
    render(
      <KnowledgeCitationViewerProvider>
        <KnowledgeCitationControl reference={{
          handle: "K1",
          messageId: "message-1",
          runId: "run-1"
        }} />
      </KnowledgeCitationViewerProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Open source K1" }));
    expect(await screen.findByRole("heading", { name: "Original visual evidence" })).toBeVisible();
    expect(screen.getByText("Quarterly revenue by region")).toBeVisible();
    expect(screen.getByRole("img", { name: "Quarterly revenue by region" })).toHaveAttribute(
      "src",
      "/api/runs/run-1/messages/message-1/citations/K1?asset=original"
    );
    expect(screen.getByText("North increased while South remained flat.")).toBeVisible();
    expect(screen.queryByText("Exact accepted excerpt")).not.toBeInTheDocument();
  });

  it("uses the same state owner for a Source Library preview", async () => {
    const source = { ...citation() };
    delete (source as { handle?: string }).handle;
    shellFetch.mockResolvedValue(jsonResponse({ source }));
    render(
      <KnowledgeCitationViewerProvider>
        <SourceButton />
      </KnowledgeCitationViewerProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview source" }));
    expect(await screen.findByRole("dialog", { name: "Knowledge source viewer" })).toBeVisible();
    expect(shellFetch).toHaveBeenCalledWith(
      "/api/me/knowledge-sources/source-1/viewer",
      expect.objectContaining({ method: "GET" })
    );
    expect(screen.getByText("Source Library")).toBeVisible();
  });
});
