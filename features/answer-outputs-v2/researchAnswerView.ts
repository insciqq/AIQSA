import type { ThreadGeneratedArtifact } from "@/lib/contracts/chats";
import { cleanAnswerText } from "@/lib/domain/answerTextMarkers";

/** The report as a file: the answer's whole text, named after its page. */
export type ResearchReportDownloadV2 = Readonly<{ fileName: string; text: string }>;

export type ResearchAnswerViewV2 = Readonly<{
  /** What the chat shows: with a research page, the summary and the notes under it; otherwise the whole text. */
  content: string;
  /** The whole report as a `.md` file, offered only beside a research page. */
  download: ResearchReportDownloadV2 | null;
  /** What reading aloud speaks: the summary beside a research page, otherwise the whole text. */
  spoken: string;
}>;

const FILE_NAME_MAX = 120;

/** A file name a reader recognises: the page's title in its own language, with only what file systems refuse taken out. */
export function researchReportFileName(title: string): string {
  const cleaned = title.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/gu, " ").replace(/\s+/gu, " ").replace(/^[\s.]+|[\s.]+$/gu, "");
  const bounded = [...cleaned].slice(0, FILE_NAME_MAX).join("").trim();
  return `${bounded || "Research report"}.md`;
}

/**
 * The answer as the chat shows it (operator decision 2026-11-05): a research that wrote a page shows its summary, the notes under it, the page's card
 * and the report as a file, since the page and the file hold the rest. Where the summary ends is the server's value on the page's card, never read
 * from the text; without the marker, or with a value the text cannot hold (an older message, an edited one), the whole text shows as today. The
 * message keeps the whole text either way, so Copy, exports, shares, print and a follow-up's context read the report.
 * `saved` is the message's text as stored, since the card's offsets count in it; every part shown is cleaned of the server's search record and
 * citation markers an answer saved before the server removed them may hold (`cleanAnswerText`).
 */
export function researchAnswerViewV2(saved: string, artifacts: readonly ThreadGeneratedArtifact[] | null | undefined): ResearchAnswerViewV2 {
  const text = cleanAnswerText(saved);
  const page = artifacts?.find((artifact) => artifact.researchPage);
  if (!page?.researchPage) return { content: text, download: null, spoken: text };
  const download = { fileName: researchReportFileName(page.title), text };
  const { notesStart, summaryEnd } = page.researchPage;
  const fits = summaryEnd !== null && summaryEnd > 0 && summaryEnd < saved.length &&
    (notesStart === null || notesStart >= summaryEnd && notesStart < saved.length);
  if (!fits) return { content: text, download, spoken: text };
  const summary = cleanAnswerText(saved.slice(0, summaryEnd)).trimEnd();
  // The notes say what of the report is doubtful or unchecked, so they stay under the summary they qualify.
  const notes = notesStart === null ? "" : cleanAnswerText(saved.slice(notesStart)).trim();
  return { content: notes ? `${summary}\n\n${notes}` : summary, download, spoken: summary };
}
