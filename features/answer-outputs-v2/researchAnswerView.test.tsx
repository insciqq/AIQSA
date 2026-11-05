import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeThreadArtifacts } from "@/components/app-shell/threadContent";
import { RunAnswerV2 } from "@/features/run-lifecycle-v2/RunLifecycleV2";
import { decodeThreadGeneratedArtifact, type ThreadArtifactSummary, type ThreadGeneratedArtifact } from "@/lib/contracts/chats";
import { AnswerOutputsV2 } from "./AnswerOutputsV2";
import { researchAnswerViewV2, researchReportFileName } from "./researchAnswerView";

const shellFetch = vi.hoisted(() => vi.fn());
vi.mock("@/components/app-shell/shellApi", () => ({ shellFetch }));

/* A synthetic research answer laid out as the server writes it: summary, report, then the notes. */
const SUMMARY = "Возьмите **X1** за 300 ₽.\n\n- Цена: X1 дороже X2 на 50 ₽, разница покупает гарантию.";
const REPORT = "## Сравнение\n\n| Модель | Цена |\n| --- | --- |\n| X1 | 300 ₽ |\n| X2 | 250 ₽ |\n\n## Детали отчёта\n\nДлинная часть, которую держит страница.";
const NOTE = "*The sources establish only part of what this report says about these facts, so rely only on what they state: X2 — warranty.*";
const BODY = `${SUMMARY}\n\n${REPORT}`;
const TEXT = `${BODY}\n\n---\n\n${NOTE}`;

const page = (researchPage: ThreadGeneratedArtifact["researchPage"]): ThreadGeneratedArtifact => ({ artifactId: "page", entrypoint: "index.html", kind: "html",
  ...(researchPage ? { researchPage } : {}), title: "Матрасы: сравнение / 2026?", versionId: "page-v1", versionNumber: 1 });
const marked = page({ notesStart: BODY.length, summaryEnd: SUMMARY.length });
const summaryOf = (artifacts: ThreadGeneratedArtifact[]): ThreadArtifactSummary => ({ citations: [], generatedArtifacts: artifacts, reasoningText: [], sources: [] });

function Answer({ artifacts, text = TEXT }: Readonly<{ artifacts: ThreadGeneratedArtifact[]; text?: string }>) {
  const artifact = summaryOf(artifacts);
  const view = researchAnswerViewV2(text, artifact.generatedArtifacts);
  return <RunAnswerV2 actionsSlot={<AnswerOutputsV2 artifact={artifact} researchReport={view.download} />} anchorId="answer" artifact={artifact}
    content={view.content} presentation={{ kind: "complete", runId: "run" }} />;
}

afterEach(() => vi.restoreAllMocks());

describe("a research answer with a page", () => {
  it("shows only the summary, the notes under it, the page's card and the report's download", () => {
    render(<Answer artifacts={[marked]} />);
    expect(screen.getByText("X1", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText(/разница покупает гарантию/u)).toBeInTheDocument();
    expect(screen.getByText(/rely only on what they state: X2 — warranty/u)).toBeInTheDocument();
    expect(screen.queryByText("Сравнение")).not.toBeInTheDocument();
    expect(screen.queryByText(/Длинная часть/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    // No expander: the page and the file hold the rest.
    expect(screen.queryByRole("button", { name: /show more|expand|full report/iu })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Open artifact: ${marked.title}` })).toBeInTheDocument();
    const report = screen.getByRole("region", { name: "Report" });
    expect(within(report).getByText("Матрасы сравнение 2026.md")).toBeInTheDocument();
    expect(within(report).getByRole("button", { name: "Download report (.md)" })).toBeInTheDocument();
  });

  it("downloads the whole text, made in the tab, under the page's name", async () => {
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return "blob:report"; });
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    let saved: { download: string; href: string } | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved = { download: this.download, href: this.href }; });
    render(<Answer artifacts={[marked]} />);
    fireEvent.click(screen.getByRole("button", { name: "Download report (.md)" }));
    expect(saved).toEqual({ download: "Матрасы сравнение 2026.md", href: "blob:report" });
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.type).toBe("text/markdown;charset=utf-8");
    expect(await blobs[0]!.text()).toBe(TEXT);
    expect(shellFetch).not.toHaveBeenCalled();
  });

  it("reads the summary aloud and leaves the whole text for Copy, which reads the message", () => {
    const view = researchAnswerViewV2(TEXT, [marked]);
    expect(view.spoken).toBe(SUMMARY);
    expect(view.download?.text).toBe(TEXT);
    // Without notes the summary stands alone.
    expect(researchAnswerViewV2(BODY, [page({ notesStart: null, summaryEnd: SUMMARY.length })]).content).toBe(SUMMARY);
  });
});

describe("an answer the server did not mark", () => {
  it("shows the whole text with no page, as today", () => {
    render(<Answer artifacts={[]} />);
    expect(screen.getByText("Сравнение")).toBeInTheDocument();
    expect(screen.getByText(/Длинная часть/u)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Report" })).not.toBeInTheDocument();
  });

  it("shows the whole text beside an ordinary artifact, an older message's card that has no marker", () => {
    render(<Answer artifacts={[page(undefined)]} />);
    expect(screen.getByText(/Длинная часть/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download report (.md)" })).not.toBeInTheDocument();
  });

  it("shows the whole text, with the download, when the offsets do not fit the text or there is no summary", () => {
    for (const researchPage of [{ notesStart: null, summaryEnd: null }, { notesStart: null, summaryEnd: TEXT.length + 5 }, { notesStart: TEXT.length, summaryEnd: 10 }]) {
      const view = researchAnswerViewV2(TEXT, [page(researchPage)]);
      expect(view).toEqual({ content: TEXT, download: { fileName: "Матрасы сравнение 2026.md", text: TEXT }, spoken: TEXT });
    }
  });
});

describe("the page's marker on its way to the chat", () => {
  it("survives the live card and the saved projection a reload reads, and an unreadable one leaves an ordinary card", () => {
    const raw = { artifact_id: "page", byte_size: 32, entrypoint: "index.html", kind: "html", research_page: { notes_start: 90, summary_end: 40 }, title: "Матрасы",
      version_id: "page-v1", version_number: 1 };
    const live = summarizeThreadArtifacts([{ data: { artifactType: "generated_artifact", payload: raw }, type: "artifact" }]);
    expect(live?.generatedArtifacts?.[0]?.researchPage).toEqual({ notesStart: 90, summaryEnd: 40 });
    const saved = decodeThreadGeneratedArtifact(live!.generatedArtifacts![0]);
    expect(saved?.researchPage).toEqual({ notesStart: 90, summaryEnd: 40 });
    expect(decodeThreadGeneratedArtifact({ ...saved, researchPage: { notesStart: 10, summaryEnd: 40 } })).toEqual({ ...saved, researchPage: undefined });
    expect(decodeThreadGeneratedArtifact({ ...saved, researchPage: { notesStart: null, summaryEnd: -1 } })?.researchPage).toBeUndefined();
    const { researchPage: _marker, ...older } = saved!;
    expect(decodeThreadGeneratedArtifact(older)).toEqual(older);
  });

  it("names the file after the page in its own words, leaving out only what file systems refuse", () => {
    expect(researchReportFileName("Матрасы: сравнение / 2026?")).toBe("Матрасы сравнение 2026.md");
    expect(researchReportFileName(" ... ")).toBe("Research report.md");
    expect(researchReportFileName("x".repeat(300))).toBe(`${"x".repeat(120)}.md`);
  });
});
