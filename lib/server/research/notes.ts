/**
 * What the answer says of research that did not fully finish. The server
 * writes these, in the language of the report, and they are never left to the
 * model: "the answer still arrives, with a visible note" (`agent_docs/RUN_CONTRACTS.md`, Answer first).
 */
export type ResearchNoteKey = "composed_failed" | "composed_no_report" | "composed_timed_out" | "followup_not_applied" | "gap_judge_unfinished" | "gate_failed" | "incomplete" | "no_findings" |
  "not_submitted" | "report_added_criteria" | "report_branches_open" | "report_criteria_missing" | "report_links_unrecorded" | "report_no_table" | "report_not_separated" | "report_pick_outside" |
  "report_pick_unbacked" | "report_typed_findings" | "report_unknown_records" | "report_unlinked_sources" | "report_unreadable_references" | "report_would_decide" | "run_failed" | "stopped" | "time_out" | "unresolved";

const NOTES: Readonly<Record<ResearchNoteKey, Readonly<{ en: string; ru: string }>>> = {
  composed_failed: { en: "The answer failed before a report was written, so the server built this from what research recorded. It draws no conclusion and picks nothing, and no check read it.",
    ru: "Ответ прервался сбоем раньше, чем был написан отчёт, поэтому сервер собрал этот текст из записей исследования. Здесь нет вывода и выбора, и проверки его не читали." },
  composed_no_report: { en: "No report was handed in, so the server built this from what research recorded. It draws no conclusion and picks nothing, and no check read it.",
    ru: "Отчёт не был передан, поэтому сервер собрал этот текст из записей исследования. Здесь нет вывода и выбора, и проверки его не читали." },
  composed_timed_out: { en: "Time ran out before a report was written, so the server built this from what research recorded. It draws no conclusion and picks nothing, and no check read it.",
    ru: "Время вышло раньше, чем был написан отчёт, поэтому сервер собрал этот текст из записей исследования. Здесь нет вывода и выбора, и проверки его не читали." },
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
  report_added_criteria: { en: "Criteria added during research, which this report does not name:", ru: "Критерии, добавленные в ходе исследования, которых нет в этом отчёте:" },
  report_branches_open: { en: "This report gives no pick for these cases, though they change the result:", ru: "В этом отчёте нет выбора для этих случаев, хотя от них зависит результат:" },
  report_criteria_missing: { en: "The comparison in this report leaves out:", ru: "В сравнении в этом отчёте нет:" },
  report_links_unrecorded: { en: "Some links in this report have no research record cited behind them, so what they back was not checked.",
    ru: "За некоторыми ссылками этого отчёта нет указанных записей исследования, поэтому то, что они подтверждают, не проверялось." },
  report_no_table: { en: "This report has no comparison table on the research's criteria.", ru: "В этом отчёте нет таблицы сравнения по критериям исследования." },
  report_not_separated: { en: "The data does not separate these options:", ru: "Данные не разделяют эти варианты:" },
  report_pick_outside: { en: "This report's pick is not among the options research compared, so it does not follow from that comparison.",
    ru: "Выбор в этом отчёте не входит в варианты, которые сравнивало исследование, поэтому из сравнения он не следует." },
  report_pick_unbacked: { en: "The records behind this report's pick were not handed in with it, so the checks did not read them:",
    ru: "Записи, на которых стоит выбор в этом отчёте, не были переданы вместе с ним, поэтому проверки их не читали:" },
  report_typed_findings: { en: "This report's findings were not tied to research records, so they were not checked against them.",
    ru: "Находки этого отчёта не были привязаны к записям исследования, поэтому с ними не сверялись." },
  report_unknown_records: { en: "This report refers to research records that do not stand, so what rests on them was not checked.",
    ru: "Этот отчёт ссылается на записи исследования, которых нет, поэтому то, что на них опирается, не проверялось." },
  report_unlinked_sources: { en: "Some sources of this report are not linked in its text.", ru: "Часть источников этого отчёта не имеет ссылок в тексте." },
  report_unreadable_references: { en: "The references of this report could not be read, so the checks did not read the records behind it.",
    ru: "Ссылки этого отчёта на записи исследования не удалось прочитать, поэтому проверки не читали записи, на которых он стоит." },
  report_would_decide: { en: "What would decide:", ru: "Что решит:" },
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
