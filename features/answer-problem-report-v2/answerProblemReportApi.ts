import {
  decodeAnswerProblemReportReadResponse,
  decodeAnswerProblemReportSaveResponse,
  type AnswerProblemReason,
  type AnswerProblemReportWire
} from "@/lib/contracts/answerProblemReports";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** `failed` covers a server failure, a malformed response and the network. */
export type AnswerProblemReportRequestError = "failed" | "invalid" | "rate_limited" | "unauthorized" | "unavailable";

export type AnswerProblemReportLoadResult =
  | Readonly<{ ok: true; report: AnswerProblemReportWire | null }>
  | Readonly<{ error: AnswerProblemReportRequestError; ok: false }>;

export type AnswerProblemReportSendResult =
  | Readonly<{ ok: true; outcome: "created" | "updated"; report: AnswerProblemReportWire }>
  | Readonly<{ error: AnswerProblemReportRequestError; ok: false }>;

export type AnswerProblemReportTarget = Readonly<{ chatId: string; messageId: string }>;

function reportPath({ chatId, messageId }: AnswerProblemReportTarget): string {
  return `/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/problem-report`;
}

function errorOf(status: number): AnswerProblemReportRequestError {
  if (status === 401) return "unauthorized";
  if (status === 404) return "unavailable";
  if (status === 429) return "rate_limited";
  if (status === 400) return "invalid";
  return "failed";
}

/** The current user's saved report on the answer, to prefill Update. */
export async function loadAnswerProblemReport(
  target: AnswerProblemReportTarget,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch
): Promise<AnswerProblemReportLoadResult> {
  try {
    const response = await fetcher(reportPath(target), { cache: "no-store", method: "GET", signal });
    if (!response.ok) return { error: errorOf(response.status), ok: false };
    const decoded = decodeAnswerProblemReportReadResponse(await response.json().catch(() => null));
    return decoded ? { ok: true, report: decoded.report } : { error: "failed", ok: false };
  } catch {
    return { error: "failed", ok: false };
  }
}

/** Creates the user's report on the answer or updates it. */
export async function sendAnswerProblemReport(
  target: AnswerProblemReportTarget,
  input: Readonly<{ comment: string | null; reason: AnswerProblemReason }>,
  fetcher: Fetcher = fetch
): Promise<AnswerProblemReportSendResult> {
  try {
    const response = await fetcher(reportPath(target), {
      body: JSON.stringify({ comment: input.comment, reason: input.reason }),
      headers: { "content-type": "application/json" },
      method: "PUT"
    });
    if (!response.ok) return { error: errorOf(response.status), ok: false };
    const decoded = decodeAnswerProblemReportSaveResponse(await response.json().catch(() => null));
    return decoded ? { ok: true, outcome: decoded.outcome, report: decoded.report } : { error: "failed", ok: false };
  } catch {
    return { error: "failed", ok: false };
  }
}
