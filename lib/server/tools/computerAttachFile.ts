import { COMPUTER_ATTACH_FILE_LIMITS, isComputerPath, type ComputerFailureCode } from "@/lib/contracts/computer";
import { CONNECT_CONTROL_CHARACTER_PATTERN } from "@/lib/contracts/connect";
import type { ThreadGeneratedFile } from "@/lib/contracts/workspace";
import { isSafeUploadFileName } from "@/lib/domain/uploadFormats";
import { fetchComputerFile, type ComputerFileBudget } from "../connect/computerFileFetch";
import type { ComputerOutputStore } from "../connect/computerOutputs";
import { logConnect } from "../connect/observability";
import type { EngineToolExecution } from "../engine/toolRegistry";
import { COMPUTER_TOOL_LIMITS, ComputerOpError, computerFailureText, type ComputerToolContext } from "./computerTools";
import { hasInvalidProviderToolArguments, type ModelToolCall, type ToolExecutionResult } from "./types";

/**
 * `computer_attach_file` (operator decision 2026-11-07): the agent gives the user a file from their computer to
 * download from the answer, as a Workspace answer gives its outputs. The file comes whole through `read_bytes`
 * (`fetchComputerFile`), then goes to the answer through `ComputerOutputStore` (`lib/server/connect/computerOutputs.ts`),
 * at most once per call: a retry finds the file the call already attached. Only the main agent has the tool
 * (`SUBAGENT_EXCLUDED_TOOL_NAMES`), since only its run is shown on the answer. The answer gets a `computer_file` event
 * so the file shows while the answer streams; a reload reads the attachment itself.
 */

export type ComputerAttachFileContext = ComputerToolContext & Readonly<{
  outputs: ComputerOutputStore;
  /** Tests; absent, the process's transfer budget. */
  budget?: ComputerFileBudget;
}>;

const MIB = 1_048_576;
const TRANSIENT_CODES: ReadonlySet<ComputerFailureCode> = new Set<ComputerFailureCode>([
  "computer_cancelled", "connect_device_disconnected", "connect_device_error"
]);

/** Failures worded for a whole file's transfer; the others keep the computer tools' words (`computerFailureText`). */
const ATTACH_TEXT: Partial<Record<ComputerFailureCode, string>> = {
  computer_file_changed: "The file changed on the computer while it was being read. Wait until nothing is writing it, then attach it again.",
  computer_file_too_large: `The file is larger than ${COMPUTER_ATTACH_FILE_LIMITS.maxBytes / MIB} MiB, the most one file on the answer may ` +
    "be. Tell the user, or make a smaller file (a compressed archive of what they need, or a part of it) and attach that.",
  computer_is_a_directory: "The path is a folder. Attach a file, or make an archive of the folder first and attach that.",
  computer_limit: "Too many operations or file transfers are running right now. Wait a moment, then try again.",
  computer_timeout: "The file took too long to come from the computer. Try a smaller file or an archive of it, or tell the user.",
  connect_unsupported: "AIQSA Connect on the computer is too old to send files. It updates itself: try again in a minute, and if " +
    "it still fails, ask the user to update AIQSA Connect."
};

function errorResult(call: Pick<ModelToolCall, "id" | "name">, code: string, message: string): ToolExecutionResult {
  return { callId: call.id, content: [{ type: "json", value: { error: code, message } }], name: call.name, status: "error" };
}

function sizeText(bytes: number): string {
  return bytes < 1_024 ? `${bytes} bytes` : bytes < MIB ? `${Math.round(bytes / 1_024)} KiB` : `${(bytes / MIB).toFixed(1)} MiB`;
}

const CONTROL_CHARACTERS = new RegExp(CONNECT_CONTROL_CHARACTER_PATTERN.source, "gu");
const encoder = new TextEncoder();

/**
 * The name a file shows on the answer: the model's, which must already be a safe file name, or the file's own on the
 * computer with control characters replaced and a too long stem cut before its extension; null for a name the model
 * gave that is not one.
 */
export function computerAttachmentName(given: string | null, own: string): string | null {
  if (given !== null) {
    const name = given.trim();
    return isSafeUploadFileName(name) ? name : null;
  }
  let name = own.replace(CONTROL_CHARACTERS, "_").trim();
  if (encoder.encode(name).byteLength > 255) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    let stem = Array.from(name.slice(0, name.length - extension.length));
    while (stem.length > 0 && encoder.encode(`${stem.join("")}${extension}`).byteLength > 255) stem = stem.slice(0, -1);
    name = `${stem.join("")}${extension}`;
  }
  return isSafeUploadFileName(name) ? name : "file";
}

function attached(call: ModelToolCall, file: ThreadGeneratedFile, reused: boolean): ToolExecutionResult {
  const again = reused ? " It was already on this answer, so the answer shows it once." : "";
  return {
    artifacts: [{ data: { artifactType: "computer_file", payload: file }, type: "artifact" }],
    callId: call.id,
    content: [{ text: `Attached ${file.fileName} (${sizeText(file.byteSize)}) to this answer.${again} The user downloads it from ` +
      "the answer; do not paste its content or write a link to it.", type: "text" }],
    name: call.name,
    status: "complete"
  };
}

/**
 * One `computer_attach_file` call. Returns a result for a success and for every definite failure; throws
 * `ComputerOpError` (transient) for a transfer cut short after the device may have answered, which the batch tries
 * again, and the run's abort for Stop or the deadline, after which nothing is attached.
 */
export async function executeComputerAttachFile(context: ComputerAttachFileContext,
  execution: Pick<EngineToolExecution, "call" | "persistedToolCallId" | "signal">): Promise<ToolExecutionResult> {
  const { call, signal } = execution;
  if (hasInvalidProviderToolArguments(call.arguments)) {
    return errorResult(call, "tool_arguments_invalid", "The arguments were not one JSON object, so nothing was sent.");
  }
  const { name: givenName, path } = call.arguments;
  if (!isComputerPath(path)) {
    return errorResult(call, "tool_arguments_invalid", "The argument \"path\" is missing or invalid, so nothing was sent.");
  }
  if (givenName !== undefined && givenName !== null && (typeof givenName !== "string" || computerAttachmentName(givenName, "") === null)) {
    return errorResult(call, "tool_arguments_invalid", "The argument \"name\" is not a file name: give a name with its extension and " +
      "without / or \\, or null for the file's own name. Nothing was sent.");
  }
  const owner = { runId: context.runId, toolCallId: execution.persistedToolCallId, userId: context.userId };
  // A retry of this call after its file was attached: the same file, never a second one.
  const earlier = await context.outputs.find(owner);
  if (earlier) return attached(call, earlier, true);
  signal.throwIfAborted();

  const left = context.timeLeftMs?.();
  const own = COMPUTER_ATTACH_FILE_LIMITS.callMs - COMPUTER_ATTACH_FILE_LIMITS.uploadMs;
  const timeoutMs = Math.max(COMPUTER_TOOL_LIMITS.minCallMs, Math.min(own, left !== undefined && Number.isFinite(left) ? left : own));
  const fetched = await fetchComputerFile({ ...(context.budget ? { budget: context.budget } : {}), cwd: context.binding.cwd,
    deviceId: context.binding.deviceId, maxBytes: COMPUTER_ATTACH_FILE_LIMITS.maxBytes, ...(context.ops ? { ops: context.ops } : {}),
    path, runId: context.runId, signal, timeoutMs, userId: context.userId });
  if (!fetched.ok) {
    // Stop or the turn's deadline: the batch's cancellation path settles the call, and nothing is attached.
    signal.throwIfAborted();
    const text = ATTACH_TEXT[fetched.code] ?? computerFailureText(fetched.code);
    if (!fetched.sent) return errorResult(call, fetched.code, `${text} Nothing was sent to the computer.`);
    if (TRANSIENT_CODES.has(fetched.code)) throw new ComputerOpError(fetched.code, { transient: true });
    return errorResult(call, fetched.code, text);
  }
  let publication: Awaited<ReturnType<ComputerOutputStore["publish"]>>;
  // The file's bytes count against the process's transfer budget until the upload is done with them, whatever ends it.
  try {
    signal.throwIfAborted();
    if (fetched.size === 0) {
      return errorResult(call, "computer_file_empty", "The file is empty, so there is nothing to download. Tell the user.");
    }
    const fileName = computerAttachmentName(typeof givenName === "string" ? givenName : null, fetched.fileName) ?? "file";
    try {
      publication = await context.outputs.publish({ ...owner, bytes: fetched.bytes, fileName, signal });
    } catch (error) {
      signal.throwIfAborted();
      logConnect({ code: "computer_output_unpublished", count: fetched.size, error, outcome: "failed", stage: "publish" });
      return errorResult(call, "computer_output_unpublished", "The file was read but could not be saved to the answer. Try once more; " +
        "if it fails again, tell the user.");
    }
  } finally {
    fetched.release();
  }
  if (!publication.ok) {
    return publication.code === "computer_output_limit"
      ? errorResult(call, publication.code, `This answer already has ${COMPUTER_ATTACH_FILE_LIMITS.filesPerRun} files from the computer, ` +
        "the most one answer takes. Tell the user which other files to ask for in their next message.")
      : errorResult(call, publication.code, "This answer can no longer take files.");
  }
  return attached(call, publication.file, publication.reused);
}
