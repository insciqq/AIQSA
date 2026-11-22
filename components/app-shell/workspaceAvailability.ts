import type { ChatWorkspaceState, WorkspaceNotRequestedReason, WorkspaceUnavailableReason } from "@/lib/contracts/workspace";
import type { WorkspaceInstallationAvailability } from "@/components/app-shell/messageRunActions";

/**
 * Whether this message can use Workspace (ambient, operator decision
 * 2026-10-20): the installation must offer it and the model must call tools.
 * `unknown` means no availability read has succeeded yet
 * (`useWorkspaceInstallationAvailability`): it is never "unavailable". A send
 * asks for Workspace and the server decides; a check that needs Workspace now
 * reads availability again instead of refusing.
 */
export type WorkspaceAvailabilityV2 =
  | Readonly<{ state: "usable" }>
  | Readonly<{ state: "unknown" }>
  | Readonly<{ cause: "installation"; reason?: WorkspaceUnavailableReason; state: "unusable" }>
  | Readonly<{ cause: "model"; reason: "model_tools_required"; state: "unusable" }>;

/**
 * The one availability decision. `installation` is the last successful read
 * (null before one) or its dispatch-time summary. Only a successful read says
 * off; a model without tools rules Workspace out whatever the installation.
 */
export function workspaceAvailabilityV2(
  installation: Pick<ChatWorkspaceState, "available" | "unavailableReason"> | WorkspaceInstallationAvailability | null | undefined,
  modelCallsTools: boolean
): WorkspaceAvailabilityV2 {
  const read = installation === "available" ? { available: true }
    : installation === "off" ? { available: false }
      : installation === "unknown" || !installation ? null : installation;
  if (read && !read.available) {
    return { cause: "installation", state: "unusable", ...("unavailableReason" in read && read.unavailableReason ? { reason: read.unavailableReason } : {}) };
  }
  if (!modelCallsTools) return { cause: "model", reason: "model_tools_required", state: "unusable" };
  return read ? { state: "usable" } : { state: "unknown" };
}

/** Why a send does not ask for Workspace (`run_accepted`), or null when it asks and the server decides. */
export function workspaceNotRequestedReasonV2(availability: WorkspaceAvailabilityV2): WorkspaceNotRequestedReason | null {
  if (availability.state !== "unusable") return null;
  return availability.cause === "installation" ? "installation_disabled" : "model_no_tools";
}

/** What a user who needs Workspace for a file is told when it is confirmed not usable. */
export function workspaceUnusableMessageV2(availability: Extract<WorkspaceAvailabilityV2, { state: "unusable" }>): string {
  return availability.reason === "model_tools_required" ? "Workspace requires a model with tool support."
    : availability.reason === "installation_disabled" ? "Workspace is disabled by the administrator."
      : "Workspace runtime is unavailable.";
}
