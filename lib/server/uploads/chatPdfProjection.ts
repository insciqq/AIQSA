import { decodeChatPdfPreparation, isLongChatPdf, type ChatPdfPreparationWire } from "../../contracts/chatPdfPreparation";

/** Deliberate owner-authorized boundary; never spread a repository row. */
export function projectChatPdfPreparation(row: Readonly<{
  completedPages: number; pageCount: number | null; retryable: boolean; route: string; state: string;
}>, terminal?: Readonly<{ phase: "failed" | "cancelled"; retryable: boolean }>): ChatPdfPreparationWire {
  const result = decodeChatPdfPreparation({ completedPages: row.completedPages,
    limitedReadingQuality: row.route === "local_text", longDocument: isLongChatPdf(row.pageCount),
    pageCount: row.pageCount, phase: terminal?.phase ?? row.state,
    retryable: terminal?.retryable ?? row.retryable, route: row.route });
  if (!result) throw new Error("pdf_preparation_projection_invalid");
  return result;
}
