import { SPREADSHEET_MAX_COLUMNS_PER_SHEET, SPREADSHEET_MAX_POPULATED_CELLS, SPREADSHEET_MAX_ROWS_PER_SHEET,
  SPREADSHEET_MAX_SHEETS } from "./spreadsheetLimits";
import { uploadAdmissionFormatFor } from "./uploadFormats";

/**
 * Processing outcomes the same file always gets again, so Retry cannot help.
 * `animated_gif_not_supported` is not one any more: no upload gets it since
 * 2026-11-07, and Retry makes an older one ready.
 */
const finalFailureCodes: ReadonlySet<string> = new Set([
  "parser_output_too_large",
  "parser_rejected"
]);

export function attachmentFailureIsFinal(code: string | null | undefined): boolean {
  return finalFailureCodes.has(code ?? "");
}

const count = (value: number) => value.toLocaleString("en-US");

/**
 * The limit a file ran into, in words for its owner, or null when its failure
 * was no limit. Only spreadsheets name numbers: the limit on other documents
 * is the operator's parser setting, which the browser does not know.
 */
export function attachmentLimitSentence(code: string | null | undefined, fileName: string): string | null {
  if (code === "animated_gif_not_supported") {
    // Only rows from before 2026-11-07 carry it.
    return "An earlier version could not send animated GIFs as images. Retry processing to send its first frame.";
  }
  if (code !== "parser_output_too_large") return null;
  return uploadAdmissionFormatFor(fileName, "", "attachment")?.parser?.kind === "spreadsheet"
    ? `This spreadsheet is over the reader's limits: ${count(SPREADSHEET_MAX_POPULATED_CELLS)} filled cells, ` +
      `${count(SPREADSHEET_MAX_ROWS_PER_SHEET)} rows and ${count(SPREADSHEET_MAX_COLUMNS_PER_SHEET)} columns per sheet, ` +
      `${count(SPREADSHEET_MAX_SHEETS)} sheets.`
    : "The text in this file is over the document reader's size limit.";
}

/** Why a message without Workspace is refused over a file whose content never reached text. */
export function attachmentNeedsWorkspaceMessage(code: string | null | undefined, fileName: string): string {
  const limit = attachmentLimitSentence(code, fileName) ?? "No text could be extracted from an attached file.";
  const recovery = attachmentFailureIsFinal(code)
    ? "Remove the file to send this message."
    : "Retry its processing, or remove the file to send this message.";
  return `${limit} Only Workspace can open it, and this message has no Workspace. ${recovery}`;
}
