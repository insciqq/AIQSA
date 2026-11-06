import {
  COMPUTER_REFUSALS,
  COMPUTER_REFUSAL_HTTP_STATUS,
  decodeComputerSendField,
  type ChatComputerBinding,
  type ComputerRefusalCode
} from "../../contracts/computer";
import type { ComputerDescription } from "../connect/computerPort";
import {
  chatComputerOf,
  computerTurnGuidance,
  computerUnavailableNote,
  freezeComputerBinding,
  type ComputerUnavailableOrigin,
  type FrozenComputerBinding
} from "../tools/computerBinding";

/**
 * Admission of a message's computer (AIQSA Connect, D-06 and D-07 of the
 * computer PRD). The send field decides for a new message: absent runs it
 * without a computer and leaves the chat's stored choice alone, `null` runs
 * it without one and clears that choice, and a binding is checked here and
 * frozen with the run, which then offers the `computer_*` tools whether the
 * computer is online or not. A regenerate repeats the run it replaces with
 * the binding that run was admitted with, whatever its request says, since
 * accepted runs keep their bindings. Only the owner's own interactive web
 * messages in personal and temporary chats take one: Assistant chats,
 * Telegram, scheduled tasks (schedules, webhooks and monitoring checks) and
 * sub-agent wake-up turns refuse a binding with one stable code, and a chat
 * whose stored choice they cannot use tells the model so.
 */

export type ComputerAdmissionDeps = Readonly<{
  /** Whether an administrator has AIQSA Connect on (`ConnectPolicy`); false while the switch cannot be read. */
  enabled(): Promise<boolean>;
  /** The user's own device, null for one that is gone or someone else's alike (`ComputerOps.describe`). */
  describe(userId: string, deviceId: string): Promise<ComputerDescription | null>;
}>;

/** Where a message comes from: only an interactive web message (a send, an edit, a regenerate, Continue) takes a computer. */
export type ComputerRunOrigin = "interactive" | ComputerUnavailableOrigin;

export type ComputerAdmissionInput = Readonly<{
  /** The chat runs with an Assistant: it never takes a computer (D-07). */
  assistantChat: boolean;
  /** The request's `COMPUTER_SEND_FIELD`, raw; ignored where `frozen` decides. */
  field: unknown;
  /** A regenerate of an admitted run: that run's binding, null for none. Undefined for a new message. */
  frozen?: FrozenComputerBinding | null;
  origin: ComputerRunOrigin;
  /** The chat's stored choice, which a message that cannot use it names in its turn note. */
  stored?: ChatComputerBinding | null;
  userId: string;
}>;

export type ComputerAdmission =
  | Readonly<{
    ok: true;
    /** What the run freezes as `NormalizedRunRequest.computer`; null for none. */
    binding: FrozenComputerBinding | null;
    /** What admission stores as the chat's choice with the run: a binding, or null to clear it; absent leaves it as it is. */
    chatChoice?: ChatComputerBinding | null;
    /** The turn's line: the computer's facts, or why its chosen computer is not available here; null for none. */
    guidance: string | null;
  }>
  | Readonly<{ ok: false; code: ComputerRefusalCode; status: 400 | 409 }>;

function refusal(key: keyof typeof COMPUTER_REFUSALS): ComputerAdmission {
  const code = COMPUTER_REFUSALS[key];
  return { code, ok: false, status: COMPUTER_REFUSAL_HTTP_STATUS[code] as 400 | 409 };
}

/** The message's computer, or why it is refused; `deps` absent means AIQSA Connect is not available to this entry point. */
export async function admitComputer(deps: ComputerAdmissionDeps | undefined, input: ComputerAdmissionInput): Promise<ComputerAdmission> {
  const repeat = input.frozen !== undefined;
  const choice = repeat ? (input.frozen ? chatComputerOf(input.frozen) : null) : decodeComputerSendField(input.field);
  if (choice === "invalid") return refusal("invalid");
  const interactive = input.origin === "interactive";
  if (!choice) {
    return { binding: null,
      // Only the user's own message changes the chat's choice; a regenerate repeats a run and changes nothing.
      ...(choice === null && interactive && !repeat ? { chatChoice: null } : {}),
      guidance: input.origin !== "interactive" && input.stored ? computerUnavailableNote(input.origin) : null,
      ok: true };
  }
  if (!interactive || input.assistantChat) return refusal("notHere");
  if (!deps || !await deps.enabled()) return refusal("disabled");
  const description = await deps.describe(input.userId, choice.deviceId);
  // Gone, revoked and someone else's computer get one answer; a description the contract refuses is no better.
  const binding = description ? freezeComputerBinding(choice, description) : null;
  if (!binding) return refusal("unavailable");
  return { binding, ...(repeat ? {} : { chatChoice: choice }), guidance: computerTurnGuidance(binding), ok: true };
}
