/**
 * What the answer says of research that did not fully finish. The server
 * writes these, in the language of the report, and they are never left to the
 * model: "the answer still arrives, with a visible note" (`agent_docs/RUN_CONTRACTS.md`, Answer first).
 */
export type ResearchNoteKey = "followup_not_applied" | "gap_judge_unfinished" | "gate_failed" | "incomplete" | "no_findings" | "not_submitted" | "run_failed" | "stopped" | "time_out" | "unresolved";

const NOTES: Readonly<Record<ResearchNoteKey, Readonly<{ en: string; ru: string }>>> = {
  followup_not_applied: { en: "What you wrote last arrived after this report was written and could not be taken into it.",
    ru: "Ваше последнее сообщение пришло уже после этого отчёта, и учесть его не удалось." },
  gap_judge_unfinished: { en: "The check for open questions could not be finished.",
    ru: "Проверку на открытые вопросы завершить не удалось." },
  gate_failed: { en: "A check of this report could not be completed, so it is not fully checked.",
    ru: "Одну из проверок этого отчёта не удалось завершить, поэтому он проверен не полностью." },
  incomplete: { en: "The answer failed while this report was being written, so it is incomplete and not checked.",
    ru: "Ответ прервался, пока писался этот отчёт, поэтому он неполный и не проверен." },
  no_findings: { en: "This report came without a list of findings, so its claims could not be checked against their sources.",
    ru: "Отчёт пришёл без списка находок, поэтому его утверждения не удалось сверить с источниками." },
  not_submitted: { en: "Research ended before the report was handed in for checking, so this is its last text and it is not checked.",
    ru: "Исследование завершилось раньше, чем отчёт был передан на проверку: это его последний текст, он не проверен." },
  run_failed: { en: "The answer failed while this report was being checked, so it is not fully checked.",
    ru: "Ответ прервался сбоем во время проверки отчёта, поэтому он проверен не полностью." },
  stopped: { en: "Stopped before the check of this report finished, so it is not fully checked.",
    ru: "Остановлено до конца проверки отчёта, поэтому он проверен не полностью." },
  time_out: { en: "Time ran out before the checks of this report finished, so it is not fully checked.",
    ru: "Время вышло раньше, чем закончились проверки отчёта, поэтому он проверен не полностью." },
  unresolved: { en: "Research ended with remarks of its last check still open, so this report is not fully checked.",
    ru: "Исследование завершилось с неразобранными замечаниями последней проверки, поэтому отчёт проверен не полностью." }
};

/** The language of the report's words, since the server's note sits beside them. */
const CYRILLIC = /\p{Script=Cyrillic}/u;

export function researchNote(key: ResearchNoteKey, report: string): string {
  return CYRILLIC.test(report) ? NOTES[key].ru : NOTES[key].en;
}

/** The answer the user reads: the report as written, then the notes, each once. */
export function researchAnswerText(report: string, notes: readonly string[]): string {
  const shown = [...new Set(notes.map((note) => note.trim()).filter(Boolean))];
  return shown.length > 0 ? `${report.trimEnd()}\n\n---\n\n${shown.map((note) => `*${note}*`).join("\n\n")}` : report;
}
