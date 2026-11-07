import { z } from "zod";
import { decodeChatComputerBinding, isComputerPath, type ChatComputerBinding } from "@/lib/contracts/computer";
import { connectWireFields, type ConnectArch, type ConnectDeviceShell, type ConnectOs } from "@/lib/contracts/connect";
import type { ComputerDescription } from "../connect/computerPort";

/**
 * A run's computer (AIQSA Connect, operator decisions O-02, O-03, O-10):
 * the device and folder admission accepted for the message, frozen in its
 * normalized request (`NormalizedRunRequest.computer`) with what the device
 * looked like then. Only the device and the folder are authority, and the
 * port rechecks the owner and the installation switch on every call; the rest
 * only describes the computer to the model in the turn context
 * (`computerTurnGuidance`) and to the user in the steps. Whether it was online
 * never changes the run's tools (D-08): an offline computer's calls answer
 * `connect_device_offline`.
 */
export type FrozenComputerBinding = Readonly<{
  deviceId: string;
  /** Where commands and relative paths start, as the user chose it; never a boundary (O-10). */
  cwd: string;
  name: string;
  os: ConnectOs;
  arch: ConnectArch;
  /** Whether the device was connected when the message was admitted. */
  online: boolean;
  /** What the connected device reported (`device_info`); absent while it was offline. */
  osVersion?: string;
  home?: string;
  shell?: ConnectDeviceShell;
}>;

const frozenSchema = z.strictObject({
  deviceId: connectWireFields.deviceId,
  cwd: z.string().refine(isComputerPath),
  name: connectWireFields.deviceName,
  os: connectWireFields.os,
  arch: connectWireFields.arch,
  online: z.boolean(),
  osVersion: connectWireFields.osVersion.optional(),
  home: connectWireFields.devicePath.optional(),
  shell: connectWireFields.shell.optional()
});

/** The binding a run's request froze; null for none and for anything malformed, which then offers no computer. */
export function decodeFrozenComputerBinding(value: unknown): FrozenComputerBinding | null {
  if (value === undefined || value === null) return null;
  const decoded = frozenSchema.safeParse(value);
  return decoded.success ? decoded.data : null;
}

/** The chat binding a frozen one was made from. */
export function chatComputerOf(binding: FrozenComputerBinding): ChatComputerBinding {
  return { cwd: binding.cwd, deviceId: binding.deviceId };
}

/**
 * The binding admission freezes from the user's choice and the port's description. A description the contract would not
 * accept back (it comes from the device) is left out field by field, so a bad report never blocks a message.
 */
export function freezeComputerBinding(choice: ChatComputerBinding, description: ComputerDescription): FrozenComputerBinding | null {
  const binding = decodeChatComputerBinding(choice);
  if (!binding) return null;
  const info = description.online ? description.info : undefined;
  const optional = <T>(schema: z.ZodType<T>, value: unknown): T | undefined => {
    const decoded = schema.safeParse(value);
    return decoded.success ? decoded.data : undefined;
  };
  const osVersion = optional(connectWireFields.osVersion, info?.osVersion);
  const home = optional(connectWireFields.devicePath, info?.home);
  const shell = optional(connectWireFields.shell, info?.shell);
  return decodeFrozenComputerBinding({
    arch: description.arch,
    cwd: binding.cwd,
    deviceId: binding.deviceId,
    ...(home ? { home } : {}),
    name: description.name,
    online: description.online,
    os: description.os,
    ...(osVersion ? { osVersion } : {}),
    ...(shell ? { shell } : {})
  });
}

const OS_LABELS: Readonly<Record<ConnectOs, string>> = { darwin: "macOS", linux: "Linux", windows: "Windows" };
const ARCH_LABELS: Readonly<Record<ConnectArch, string>> = { amd64: "x64", arm64: "arm64" };

/** "Windows" or "macOS": what the shell description is written for. */
export function computerOsLabel(os: ConnectOs): string {
  return OS_LABELS[os];
}

/**
 * How the computer's turn-context line begins. Sub-agents keep the parent's turn guidance only by such prefixes
 * (`subagentRequest`), so this line reaches them as `WORKSPACE_TURN_GUIDANCE_PREFIX`'s does.
 */
export const COMPUTER_TURN_GUIDANCE_PREFIX = "The user's computer \"";

/**
 * How the agent works on a project on the user's computer, as a coding agent does: the project's own instructions for
 * agents first, its own checks after a change. The files are only named, never read by the server, so they reach the
 * model only through the agent's own reads, as untrusted content like any other file there.
 */
const COMPUTER_PROJECT_GUIDANCE = "Before you work on a project there, read its instructions for agents (AGENTS.md or " +
  "CLAUDE.md in the project's root and in the folder you work in) when this conversation has not read them yet, and follow " +
  "them; after changing a project, run its own checks (tests, linters, build) when it has them.";

/**
 * The run's one line about its computer (D-08), in the turn context and never the system prompt, so the prompt and the
 * tool list stay the same between turns with the same binding whatever the device reports.
 */
export function computerTurnGuidance(binding: FrozenComputerBinding): string {
  const platform = `${binding.osVersion ?? computerOsLabel(binding.os)}, ${ARCH_LABELS[binding.arch]}`;
  const shell = binding.shell ? `; shell: ${binding.shell.name}${binding.shell.version ? ` ${binding.shell.version}` : ""}` : "";
  // A JSON string starts with the quote the prefix ends with.
  const computer = `The user's computer ${JSON.stringify(binding.name)}`;
  const folder = `Working folder: ${binding.cwd}.${binding.home ? ` Home: ${binding.home}.` : ""}`;
  if (binding.online) {
    return `${computer} is connected for this chat (${platform}${shell}). ${folder} ` +
      "Use the computer_* tools for the user's files and commands there; the Workspace is a separate cloud sandbox and cannot see " +
      "these files. " + COMPUTER_PROJECT_GUIDANCE;
  }
  return `${computer} is chosen for this chat but was offline when this message was sent ` +
    `(${platform}). ${folder} Use the computer_* tools for the user's files and commands there. While they answer ` +
    "connect_device_offline, tell the user the computer is offline and that AIQSA Connect must be running on it; never use the " +
    "Workspace in its place, which cannot see these files.";
}

/** Where a chat's computer is never available (D-07), for the turn note of a chat that has one chosen. */
export type ComputerUnavailableOrigin = "scheduled" | "telegram" | "wake_up";

/**
 * The turn note of a message that cannot use the computer its chat has chosen, so the model says so instead of looking
 * for tools it does not have.
 */
export function computerUnavailableNote(origin: ComputerUnavailableOrigin): string {
  const where = origin === "telegram" ? "from Telegram"
    : origin === "scheduled" ? "in automations"
      : "in this turn, which sub-agent reports started rather than the user";
  return `Computer access is not available ${where}: the computer chosen in this chat works only in messages the user sends ` +
    "from AIQSA in the browser, so no computer_* tools are offered here. If the user asks for something on their computer, " +
    "say that it needs a message from the browser chat.";
}
