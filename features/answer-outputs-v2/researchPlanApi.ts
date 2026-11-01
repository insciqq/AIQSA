import {
  RESEARCH_PLAN_RELEASES,
  type ResearchPlanEdit,
  type ResearchPlanRelease
} from "@/lib/contracts/research";

/** What the card reads of a window: `ResearchPlanWindowView` less the questions and criteria, which a person never edits and the card never shows. */
export type ResearchPlanCardView = Readonly<{
  answer: Readonly<{ changed: boolean; plan: ResearchPlanEdit; releasedBy: ResearchPlanRelease }> | null;
  heldUntil: string | null;
  proposal: ResearchPlanEdit;
  runId: string;
  serverTime: string;
  windowEndsAt: string;
}>;

export type ResearchPlanOutcome = "applied" | "closed";

/** What a POST takes (`decodeResearchPlanAction`); `save` closes the window and starts research at once. */
export type ResearchPlanRequest =
  | Readonly<{ action: "cancel_hold" | "hold" | "start" }>
  | Readonly<{ action: "save"; plan: ResearchPlanEdit }>;

/** A failed plan request: the server's stable code when it sent one. A malformed answer is one too, with status 200 and no code. */
export class ResearchPlanApiError extends Error {
  constructor(readonly code: string | null, readonly status: number) {
    super(code ?? `research_plan_http_${status}`);
    this.name = "ResearchPlanApiError";
  }
}

const malformed = () => new ResearchPlanApiError(null, 200);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

const isTexts = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

function decodeWords(value: unknown): ResearchPlanEdit | null {
  if (!isRecord(value) || typeof value.understood !== "string" || !isTexts(value.assumptions) || !isTexts(value.steps)) return null;
  return { assumptions: value.assumptions, steps: value.steps, understood: value.understood };
}

function decodeView(value: unknown): ResearchPlanCardView | null {
  if (!isRecord(value) || typeof value.runId !== "string" || !isTime(value.serverTime) || !isTime(value.windowEndsAt)) return null;
  const { heldUntil } = value;
  if (heldUntil !== null && !isTime(heldUntil)) return null;
  const proposal = decodeWords(value.proposal);
  if (!proposal) return null;
  if (value.answer === null) {
    return { answer: null, heldUntil, proposal, runId: value.runId, serverTime: value.serverTime, windowEndsAt: value.windowEndsAt };
  }
  if (!isRecord(value.answer) || typeof value.answer.changed !== "boolean") return null;
  const plan = decodeWords(value.answer.plan);
  const released = value.answer.releasedBy;
  const releasedBy = RESEARCH_PLAN_RELEASES.find((release) => release === released);
  if (!plan || !releasedBy) return null;
  return { answer: { changed: value.answer.changed, plan, releasedBy }, heldUntil, proposal, runId: value.runId, serverTime: value.serverTime,
    windowEndsAt: value.windowEndsAt };
}

async function request(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ResearchPlanApiError(isRecord(body) && typeof body.code === "string" ? body.code : null, response.status);
  return body;
}

const planPath = (chatId: string) => `/api/chats/${encodeURIComponent(chatId)}/research/plan`;

export async function readResearchPlan(input: Readonly<{ chatId: string; runId: string; signal?: AbortSignal }>): Promise<ResearchPlanCardView> {
  const view = decodeView(await request(`${planPath(input.chatId)}?runId=${encodeURIComponent(input.runId)}`, { signal: input.signal }));
  if (!view) throw malformed();
  return view;
}

/** `closed`: the window had closed before this action reached it, and the view says how. */
export async function actOnResearchPlan(input: Readonly<{ chatId: string; request: ResearchPlanRequest; runId: string }>):
Promise<Readonly<{ outcome: ResearchPlanOutcome; view: ResearchPlanCardView }>> {
  const body = await request(planPath(input.chatId), {
    body: JSON.stringify({ ...input.request, runId: input.runId }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (!isRecord(body) || (body.outcome !== "applied" && body.outcome !== "closed")) throw malformed();
  const view = decodeView(body.view);
  if (!view) throw malformed();
  return { outcome: body.outcome, view };
}
