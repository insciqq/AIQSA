import { describe, expect, it } from "vitest";
import { researchAnswerLayout, researchAnswerText, researchContentNotes, researchCounterEvidenceNote, researchNote, researchPartialClaimsNote } from "./notes";

describe("where an answer's summary ends and its notes start", () => {
  const draft = { report: "## Сравнение\n\n| Модель | Цена |\n| X1 | 300 ₽ |\n",
    summary: { priorities: [{ criterionKey: "price", recordIds: [], text: "Цена: X1 дороже X2 на 50 ₽." }], rowKeys: [], text: "Возьмите X1." } };
  const summary = "Возьмите X1.\n\n- Цена: X1 дороже X2 на 50 ₽.";

  it("comes from the draft the text was made of, the server's priority lines inside the summary", () => {
    const text = researchAnswerText(`${summary}\n\n${draft.report}`, [researchNote("time_out")]);
    const { notesStart, summaryEnd } = researchAnswerLayout(text, draft);
    expect(text.slice(0, summaryEnd!)).toBe(summary);
    expect(text.slice(notesStart!)).toBe(`\n\n---\n\n*${researchNote("time_out")}*`);
    // No notes: the text ends with the report, whatever space the report ended with.
    expect(researchAnswerLayout(researchAnswerText(`${summary}\n\n${draft.report}`, []), draft)).toEqual({ notesStart: null, summaryEnd: summary.length });
  });

  it("moves with a secret the answer masks, and marks nothing on a text that is not the draft's, nor a summary a draft lacks", () => {
    const masked = (part: string) => part.replaceAll("X1", "•••");
    const text = masked(researchAnswerText(`${summary}\n\n${draft.report}`, [researchNote("time_out")]));
    const { notesStart, summaryEnd } = researchAnswerLayout(text, draft, masked);
    expect(text.slice(0, summaryEnd!)).toBe(masked(summary));
    expect(text.slice(notesStart!).trim()).toBe(`---\n\n*${researchNote("time_out")}*`);
    expect(researchAnswerLayout("Something else entirely.", draft)).toEqual({ notesStart: null, summaryEnd: null });
    expect(researchAnswerLayout(researchAnswerText(draft.report, [researchNote("time_out")]), { report: draft.report, summary: null }))
      .toEqual({ notesStart: draft.report.trimEnd().length, summaryEnd: null });
  });
});

describe("what a research's page takes of the answer's notes", () => {
  it("keeps the notes about its content, each once, and leaves out every word about how it was made", () => {
    const partial = researchPartialClaimsNote(["Model X1 — Owner reviews"], 5)!;
    const against = researchCounterEvidenceNote([{ claim: "The X1 sags after a year.", quote: null, url: "https://lab.example/x1" }])!;
    const rejected = "The checks did not confirm these facts this report cites, so do not rely on them: Model X2 — Load.";
    expect(researchContentNotes([researchNote("no_findings"), partial, ` ${partial} `, researchNote("gate_failed"), against, researchNote("time_out"), rejected,
      researchNote("followup_not_applied"), ""])).toEqual([partial, against, rejected]);
  });
});

describe("a source's narrower support in the answer", () => {
  it("names the facts by the server's labels, never the claim's or the checker's words, and without a technical verdict label", () => {
    const note = researchPartialClaimsNote(["Model X1 — Owner reviews", "Model X1 — Owner reviews"], 5);
    expect(note).toBe("The sources establish only part of what this report says about these facts, so rely only on what they state: Model X1 — Owner reviews.");
    expect(researchAnswerText("Report.", [note!, note!])).toBe(`Report.\n\n---\n\n*${note}*`);
    expect(note).not.toMatch(/partly|not checked|not verified|not_verified/u);
  });

  it("is one line however many facts, and says so when some have no label", () => {
    expect(researchPartialClaimsNote([], 5)).toBeNull();
    expect(researchPartialClaimsNote([null], 5)).toBe("The sources establish only part of some facts behind the options this report recommends, so rely only on what they state.");
    expect(researchPartialClaimsNote(["A — x", "B — y", null], 1)).toBe("The sources establish only part of what this report says about these facts, so rely only on what they state: A — x; and others.");
  });
});
