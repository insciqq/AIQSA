import { z } from "zod";

/**
 * Wire contract of the live Workspace browser (operator decisions 2026-10-26):
 * while the agent's Workspace browser runs in a turn, the run owner's chat can
 * watch it, take control, and answer a handoff the agent asked for (sign-in, a
 * code, a CAPTCHA, a consent or a choice only the user should make). Frames,
 * steps and input travel guest -> runner -> app -> the owner's browser in
 * memory only: nothing here is stored, logged or shown to the model, which
 * learns only a handoff's outcome and, after the user returns control, the
 * current page. The routes are keyed by chat (a chat runs one turn at a time)
 * and accept only the run owner's signed-in browser session.
 */

export const BROWSER_LIVE_PROTOCOL_VERSION = 1;

export const BROWSER_LIVE_LIMITS = Object.freeze({
  /** Base64 characters of one JPEG frame. */
  frameBase64Chars: 512 * 1024,
  /** Pixels of a frame side; the guest scales larger viewports down. */
  frameMaxSide: 1920,
  /** Frames a stream sends per second at most; the guest paces below this. */
  framesPerSecond: 10,
  /** Characters of one text insertion (a phone keyboard sends whole words). */
  textChars: 1_024,
  /** Characters of `KeyboardEvent.key` and `KeyboardEvent.code`. */
  keyChars: 32,
  /** Characters of the agent's message on a handoff card. */
  handoffMessageChars: 300,
  /** Seconds a handoff waits at most; never past the turn's tool time. */
  handoffWaitSeconds: 600,
  /** Steps one `steps` event carries; the panel keeps the newest. */
  stepsPerEvent: 50,
  /** Characters of a step's target or path. */
  stepTextChars: 200,
  urlChars: 2_048,
  titleChars: 300,
  /** Seconds between SSE heartbeats. */
  heartbeatSeconds: 15,
  /** Input requests one owner may send per second; more get `browser_live_rate_limited`. */
  inputsPerSecond: 60
});

/** Why the agent hands the browser to the user. */
export const BROWSER_HANDOFF_REASONS = ["sign_in", "verification_code", "captcha", "consent", "user_choice", "other"] as const;
export type BrowserHandoffReason = (typeof BROWSER_HANDOFF_REASONS)[number];

/** How a handoff ended, as the model learns it. */
export const BROWSER_HANDOFF_OUTCOMES = ["completed", "cancelled", "timed_out"] as const;
export type BrowserHandoffOutcome = (typeof BROWSER_HANDOFF_OUTCOMES)[number];

/** Who drives the browser: the agent, or the user after Take control or during a handoff. */
export const BROWSER_LIVE_CONTROLLERS = ["agent", "user"] as const;
export type BrowserLiveController = (typeof BROWSER_LIVE_CONTROLLERS)[number];

/** Whether the turn's browser is up: `absent` before the agent opened it, `stopped` once the turn ended it. */
export const BROWSER_LIVE_BROWSER_STATES = ["absent", "running", "stopped"] as const;
export type BrowserLiveBrowserState = (typeof BROWSER_LIVE_BROWSER_STATES)[number];

/** Why a stream ended; the panel may reopen it only after `replaced` or `error`. */
export const BROWSER_LIVE_END_REASONS = ["run_finished", "browser_stopped", "not_available", "replaced", "error"] as const;
export type BrowserLiveEndReason = (typeof BROWSER_LIVE_END_REASONS)[number];

/** Refusals of the routes; the body is always `{code}`. Unknown, foreign and finished chats get the same one. */
export const BROWSER_LIVE_ERROR_CODES = [
  "browser_live_not_found",
  "browser_live_unavailable",
  "browser_live_request_invalid",
  "browser_live_not_in_control",
  "browser_live_handoff_stale",
  "browser_live_rate_limited"
] as const;
export type BrowserLiveErrorCode = (typeof BROWSER_LIVE_ERROR_CODES)[number];

export const BROWSER_LIVE_ERROR_HTTP_STATUS = Object.freeze({
  browser_live_not_found: 404,
  browser_live_unavailable: 409,
  browser_live_request_invalid: 400,
  browser_live_not_in_control: 409,
  browser_live_handoff_stale: 409,
  browser_live_rate_limited: 429
} satisfies Record<BrowserLiveErrorCode, number>);

function chatPath(chatId: string): string {
  return `/api/chats/${encodeURIComponent(chatId)}/browser`;
}

/** GET: the SSE stream of `state`, `frame`, `steps` and `end` events; open only while the panel is open. */
export function browserLiveStreamPath(chatId: string): string {
  return `${chatPath(chatId)}/stream`;
}

/** POST `BrowserLiveInput`: one pointer, key or text input; only while the user controls the browser. */
export function browserLiveInputPath(chatId: string): string {
  return `${chatPath(chatId)}/input`;
}

/** POST `BrowserLiveControlRequest`: Take control or Return control. */
export function browserLiveControlPath(chatId: string): string {
  return `${chatPath(chatId)}/control`;
}

/** POST `BrowserLiveHandoffRequest`: Done or Cancel on the pending handoff. */
export function browserLiveHandoffPath(chatId: string): string {
  return `${chatPath(chatId)}/handoff`;
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
// Control characters other than tab, line feed and carriage return; they never belong in a label or text input.
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const ACTION_PATTERN = /^[a-z][a-z_]{0,19}$/u;

function text(max: number) {
  return z.string().max(max).refine((value) => !CONTROL_PATTERN.test(value), "control characters");
}

function boundedInt(min: number, max: number) {
  return z.number().int().min(min).max(max);
}

const idSchema = z.string().regex(ID_PATTERN);
const timestampSchema = z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
const sideSchema = boundedInt(1, BROWSER_LIVE_LIMITS.frameMaxSide);
/** Bit mask of Alt 1, Ctrl 2, Meta 4, Shift 8 (CDP `Input.dispatch*Event` modifiers). */
const modifiersSchema = boundedInt(0, 15);
const coordinateSchema = z.number().finite().min(0).max(BROWSER_LIVE_LIMITS.frameMaxSide);
const wheelDeltaSchema = z.number().finite().min(-10_000).max(10_000);

export const browserLiveHandoffSchema = z.strictObject({
  id: idSchema,
  reason: z.enum(BROWSER_HANDOFF_REASONS),
  message: text(BROWSER_LIVE_LIMITS.handoffMessageChars),
  startedAt: timestampSchema,
  expiresAt: timestampSchema
});
export type BrowserLiveHandoff = z.infer<typeof browserLiveHandoffSchema>;

/** The panel's whole state; sent on connect and on every change. */
export const browserLiveStateEventSchema = z.strictObject({
  version: z.literal(BROWSER_LIVE_PROTOCOL_VERSION),
  runId: idSchema,
  browser: z.enum(BROWSER_LIVE_BROWSER_STATES),
  controller: z.enum(BROWSER_LIVE_CONTROLLERS),
  handoff: browserLiveHandoffSchema.nullable(),
  /**
   * Whether sign-ins made in this browser are saved to the user's Secrets after the turn (personal chats);
   * false where save-back does not run (Assistant and temporary chats), so the card says it will not be remembered.
   */
  signInRemembered: z.boolean(),
  /** The page the browser shows, for the panel's address line; the owner's own content. */
  page: z.strictObject({ url: text(BROWSER_LIVE_LIMITS.urlChars), title: text(BROWSER_LIVE_LIMITS.titleChars) }).nullable()
});
export type BrowserLiveStateEvent = z.infer<typeof browserLiveStateEventSchema>;

/**
 * One JPEG frame of the page viewport. Input coordinates are in this frame's
 * pixels; the server maps them to the page.
 */
export const browserLiveFrameEventSchema = z.strictObject({
  seq: boundedInt(0, Number.MAX_SAFE_INTEGER),
  mime: z.literal("image/jpeg"),
  data: z.string().min(4).max(BROWSER_LIVE_LIMITS.frameBase64Chars).regex(BASE64_PATTERN),
  width: sideSchema,
  height: sideSchema
});
export type BrowserLiveFrameEvent = z.infer<typeof browserLiveFrameEventSchema>;

/** A step of the turn's step log (`[browser #N] action: target @ host/path`). */
export const browserLiveStepSchema = z.strictObject({
  n: boundedInt(1, 99_999),
  action: z.string().regex(ACTION_PATTERN),
  target: text(BROWSER_LIVE_LIMITS.stepTextChars),
  host: text(253),
  path: text(BROWSER_LIVE_LIMITS.stepTextChars)
});
export type BrowserLiveStep = z.infer<typeof browserLiveStepSchema>;

/** The newest steps of the turn, oldest first; each event replaces the panel's list. */
export const browserLiveStepsEventSchema = z.strictObject({
  steps: z.array(browserLiveStepSchema).max(BROWSER_LIVE_LIMITS.stepsPerEvent)
});
export type BrowserLiveStepsEvent = z.infer<typeof browserLiveStepsEventSchema>;

export const browserLiveEndEventSchema = z.strictObject({ reason: z.enum(BROWSER_LIVE_END_REASONS) });
export type BrowserLiveEndEvent = z.infer<typeof browserLiveEndEventSchema>;

export type BrowserLiveEvent =
  | Readonly<{ type: "state"; value: BrowserLiveStateEvent }>
  | Readonly<{ type: "frame"; value: BrowserLiveFrameEvent }>
  | Readonly<{ type: "steps"; value: BrowserLiveStepsEvent }>
  | Readonly<{ type: "end"; value: BrowserLiveEndEvent }>;

const EVENT_SCHEMAS = {
  state: browserLiveStateEventSchema,
  frame: browserLiveFrameEventSchema,
  steps: browserLiveStepsEventSchema,
  end: browserLiveEndEventSchema
} as const;

/** One SSE event by its `event:` name and `data:` JSON text; null for anything else. */
export function decodeBrowserLiveEvent(name: string, data: string): BrowserLiveEvent | null {
  if (!Object.hasOwn(EVENT_SCHEMAS, name)) return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  const type = name as keyof typeof EVENT_SCHEMAS;
  const parsed = EVENT_SCHEMAS[type].safeParse(value);
  return parsed.success ? { type, value: parsed.data } as BrowserLiveEvent : null;
}

/**
 * One input from the panel, applied with CDP `Input.dispatchMouseEvent`,
 * `dispatchKeyEvent` or `insertText`. Touch arrives as mouse input; a phone
 * keyboard types through a real text field that sends `text`.
 */
export const browserLiveInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("mouse"),
    type: z.enum(["move", "down", "up", "wheel"]),
    x: coordinateSchema,
    y: coordinateSchema,
    button: z.enum(["none", "left", "middle", "right"]).optional(),
    clickCount: boundedInt(0, 3).optional(),
    deltaX: wheelDeltaSchema.optional(),
    deltaY: wheelDeltaSchema.optional(),
    modifiers: modifiersSchema.optional()
  }),
  z.strictObject({
    kind: z.literal("key"),
    type: z.enum(["down", "up"]),
    key: z.string().min(1).max(BROWSER_LIVE_LIMITS.keyChars),
    code: z.string().max(BROWSER_LIVE_LIMITS.keyChars),
    modifiers: modifiersSchema.optional()
  }),
  z.strictObject({
    kind: z.literal("text"),
    text: z.string().min(1).max(BROWSER_LIVE_LIMITS.textChars).refine((value) => !CONTROL_PATTERN.test(value), "control characters")
  })
]);
export type BrowserLiveInput = z.infer<typeof browserLiveInputSchema>;

export const browserLiveControlRequestSchema = z.strictObject({ action: z.enum(["take", "return"]) });
export type BrowserLiveControlRequest = z.infer<typeof browserLiveControlRequestSchema>;

export const browserLiveHandoffRequestSchema = z.strictObject({ handoffId: idSchema, action: z.enum(["done", "cancel"]) });
export type BrowserLiveHandoffRequest = z.infer<typeof browserLiveHandoffRequestSchema>;
