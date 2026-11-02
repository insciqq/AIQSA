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

/** What the check that tries to refute a report found. `quote` only where the quote check found it on an opened page. */
export type ResearchCounterEvidence = Readonly<{ claim: string; quote: string | null; url: string }>;

/** How that check ended when it has no such finding to name. */
export type ResearchSkepticOutcome = "busy" | "failed" | "no_time" | "none_found" | "timed_out" | "unavailable" | "unbacked";

const SKEPTIC_NOTES: Readonly<Record<ResearchSkepticOutcome, Readonly<{ en: string; ru: string }>>> = {
  busy: { en: "The check that looks for evidence against the conclusion could not start, as this chat is running as many sub-agents as it may.",
    ru: "Проверка, которая ищет доводы против вывода, не запустилась: в этом чате уже работает максимум субагентов." },
  failed: { en: "The check that looks for evidence against the conclusion failed.",
    ru: "Проверка, которая ищет доводы против вывода, не удалась." },
  no_time: { en: "The check that looks for evidence against the conclusion did not run, as too little time was left for it.",
    ru: "Проверка, которая ищет доводы против вывода, не запускалась: на неё не осталось времени." },
  none_found: { en: "The check that looks for evidence against the conclusion found nothing that outweighs it.",
    ru: "Проверка, которая ищет доводы против вывода, не нашла ничего, что его перевесило бы." },
  timed_out: { en: "Time ran out during the check that looks for evidence against the conclusion.",
    ru: "Время вышло во время проверки, которая ищет доводы против вывода." },
  unavailable: { en: "The check that looks for evidence against the conclusion did not run: the model chosen for it is not available to this answer.",
    ru: "Проверка, которая ищет доводы против вывода, не запускалась: выбранная для неё модель недоступна этому ответу." },
  unbacked: { en: "The check that looks for evidence against the conclusion named something it could not show on a page it opened, so that is left out.",
    ru: "Проверка, которая ищет доводы против вывода, назвала то, что не смогла показать на открытой странице, поэтому это не учтено." }
};

/** `mainModel`: it found nothing on the model that wrote the report, which the answer must say (`agent_docs/RUN_CONTRACTS.md`, Research). */
export function researchSkepticNote(outcome: ResearchSkepticOutcome, report: string, mainModel: string | null = null): string {
  const russian = CYRILLIC.test(report);
  const note = SKEPTIC_NOTES[outcome][russian ? "ru" : "en"];
  if (mainModel === null) return note;
  return `${note} ${russian ? `Её выполнила основная модель (${mainModel}), которая и писала этот отчёт, поэтому она не независимая.` : `It ran on the main model (${mainModel}), which also wrote this report, so it is not independent.`}`;
}

/** Names what that check found, in words true whether or not the report still holds or has since weighed it: only the same check can clear it. */
export function researchCounterEvidenceNote(found: readonly ResearchCounterEvidence[], report: string): string {
  const items = found.map(({ claim, quote, url }, index) => `${found.length > 1 ? `${index + 1}) ` : ""}${claim}${quote ? ` («${quote}»)` : ""}, ${url}`).join("; ");
  return CYRILLIC.test(report) ? `Проверка, которая ищет доводы против вывода, нашла то, что может его опровергать; если выше это не учтено, учитывайте это сами: ${items}.`
    : `The check that looks for evidence against the conclusion found what may overturn it; if the report above does not weigh this, weigh it yourself: ${items}.`;
}

/** The answer the user reads: the report as written, then the notes, each once. */
export function researchAnswerText(report: string, notes: readonly string[]): string {
  const shown = [...new Set(notes.map((note) => note.trim()).filter(Boolean))];
  return shown.length > 0 ? `${report.trimEnd()}\n\n---\n\n${shown.map((note) => `*${note}*`).join("\n\n")}` : report;
}
