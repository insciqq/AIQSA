import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactPreviewDrawerV2,
  GeneratedArtifactCardV2,
  GeneratedArtifactStackV2
} from "./ArtifactsV2";
import type { GeneratedArtifactProjection } from "./contracts";
import {
  artifactFixturesForState,
  readyReportArtifact
} from "./fixtures";

function artifactFor(state: Parameters<typeof artifactFixturesForState>[0]) {
  const artifact = artifactFixturesForState(state)[0];
  if (!artifact) throw new Error(`missing_${state}_artifact_fixture`);
  return artifact;
}

describe("Artifacts v2", () => {
  it("shows bounded normalized lifecycle phases without claiming a ready file", () => {
    render(<GeneratedArtifactCardV2 artifact={artifactFor("generating")} />);

    const card = screen.getByRole("article", { name: "Generating file report_q3.xlsx" });
    expect(card).toHaveAttribute("aria-busy", "true");
    expect(card).toHaveTextContent("Validating file…");
    expect(within(card).getByRole("list", { name: "File generation stages" })).toHaveTextContent(
      "Creating fileValidating fileRendering preview"
    );
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("binds ready actions to the exact immutable version without rendering private ids", () => {
    const onDownload = vi.fn();
    const onPreview = vi.fn();
    const onUse = vi.fn();
    const { container } = render(
      <GeneratedArtifactCardV2
        artifact={readyReportArtifact}
        onDownload={onDownload}
        onPreview={onPreview}
        onUseInNextMessage={onUse}
      />
    );

    const card = screen.getByRole("article", { name: "File report_q3.xlsx" });
    expect(card).toHaveTextContent("report_q3.xlsxv2");
    expect(card).toHaveTextContent("XLSX · 3 sheets · formulas verified · 214 KB");
    fireEvent.click(within(card).getByRole("button", { name: "Preview" }));
    fireEvent.click(within(card).getByRole("button", { name: "Download" }));
    fireEvent.click(within(card).getByRole("button", {
      name: "Use in next message"
    }));
    expect(onPreview).toHaveBeenCalledWith(
      readyReportArtifact,
      expect.objectContaining({ id: "artifact-version-private-report-v2" })
    );
    expect(onDownload).toHaveBeenCalledWith(
      readyReportArtifact,
      expect.objectContaining({ id: "artifact-version-private-report-v2" })
    );
    expect(onUse).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("private-report");
    expect(container.textContent).not.toContain("message-private");
  });

  it("keeps valid Download when preview rendering failed", () => {
    const onDownload = vi.fn();
    render(
      <GeneratedArtifactCardV2
        artifact={artifactFor("preview-unavailable")}
        onDownload={onDownload}
        onPreview={vi.fn()}
        onUseInNextMessage={vi.fn()}
      />
    );

    expect(screen.getByText("Preview unavailable")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledWith(
      expect.objectContaining({ name: "unsupported-preview.xlsx" }),
      expect.objectContaining({ downloadAvailable: true })
    );
  });

  it("keeps failed, cancelled, stacked, and malformed-version states honest", () => {
    const retry = vi.fn();
    const details = vi.fn();
    const { rerender } = render(
      <GeneratedArtifactCardV2
        artifact={artifactFor("failed")}
        onDetails={details}
        onRetry={retry}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("broken reference to sheet “Сводная”");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(details).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();

    rerender(<GeneratedArtifactCardV2 artifact={artifactFor("cancelled")} />);
    expect(screen.getByText("File generation cancelled")).toBeVisible();

    rerender(<GeneratedArtifactStackV2 artifacts={artifactFixturesForState("stack")} />);
    expect(screen.getAllByRole("article")).toHaveLength(2);

    const malformed: GeneratedArtifactProjection = {
      ...readyReportArtifact,
      boundVersionId: "missing-private-version"
    };
    rerender(<GeneratedArtifactCardV2 artifact={malformed} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The exact file version is unavailable");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("switches safe preview data and lineage without mutating the bound card version", async () => {
    const onDownload = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <GeneratedArtifactCardV2
            artifact={readyReportArtifact}
            onPreview={() => setOpen(true)}
          />
          {open && readyReportArtifact.status === "ready" ? (
            <ArtifactPreviewDrawerV2
              artifact={readyReportArtifact}
              onClose={() => setOpen(false)}
              onDownload={onDownload}
            />
          ) : null}
        </>
      );
    }

    const { container } = render(<Harness />);
    const opener = screen.getByRole("button", { name: "Preview" });
    opener.focus();
    fireEvent.click(opener);
    const drawer = screen.getByRole("dialog", { name: "File preview: report_q3.xlsx" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Close preview" })).toHaveFocus());
    expect(drawer).toHaveTextContent("v2");
    expect(drawer).toHaveTextContent("Created from v1");
    expect(drawer.textContent).not.toContain("artifact-version-private");
    expect(drawer.textContent).not.toContain("message-private");
    expect(container.textContent).not.toContain("object-key");

    fireEvent.click(within(drawer).getByRole("button", { name: /v1.*Original answer/ }));
    expect(within(drawer).getByText("₽14.8M")).toBeVisible();
    fireEvent.click(within(drawer).getByRole("tab", { name: "Продажи" }));
    expect(within(drawer).getByText("₽8.9M")).toBeVisible();
    fireEvent.keyDown(within(drawer).getByRole("tab", { name: "Продажи" }), {
      key: "ArrowRight"
    });
    expect(within(drawer).getByRole("tab", { name: "Расходы" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(within(drawer).getByText("Операционные")).toBeVisible();
    fireEvent.click(within(drawer).getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledWith(
      readyReportArtifact,
      expect.objectContaining({ id: "artifact-version-private-report-v1" })
    );

    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(drawer).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.getByRole("article", { name: "File report_q3.xlsx" })).toHaveTextContent("v2");
  });
});
