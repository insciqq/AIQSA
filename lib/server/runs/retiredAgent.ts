/**
 * The Codex Agent mode is removed (operator decision 2026-10-23): a request
 * that still asks for it is refused with this code, never answered without
 * it. Turns accepted as Agent turns stay readable history only.
 */
export const AGENT_MODE_REMOVED = "agent_mode_removed";

/** Whether an accepted request, as stored, was a Codex Agent turn. */
export function isRetiredAgentRequest(request: unknown): boolean {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return false;
  const agent = (request as Record<string, unknown>).agent;
  return typeof agent === "object" && agent !== null;
}
