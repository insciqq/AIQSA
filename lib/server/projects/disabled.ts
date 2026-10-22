import { PROJECTS_DISABLED_CODE, PROJECTS_ENABLED } from "../../domain/disabledAreas";

/** The refusal of any Project change while Projects are disabled; reads keep working. */
export function projectsDisabledResponse(): Response {
  return Response.json({ error: PROJECTS_DISABLED_CODE }, { status: 409 });
}

/**
 * Thrown by a repository that found the caller's chat to be a Project chat
 * while Projects are disabled; its handler answers `projectsDisabledResponse`.
 * The repository has already authorized the chat, so the refusal reveals
 * nothing about chats the caller cannot open.
 */
export class ProjectsDisabledError extends Error {
  readonly code = PROJECTS_DISABLED_CODE;

  constructor() {
    super(PROJECTS_DISABLED_CODE);
    this.name = "ProjectsDisabledError";
  }
}

/**
 * A Project change handler, or while Projects are disabled
 * (`lib/domain/disabledAreas.ts`) a refusal before authentication, parsing
 * or any repository access, as for the dormant Project Memory routes.
 */
export function refusedWhileProjectsDisabled<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  return PROJECTS_ENABLED ? handler : async () => projectsDisabledResponse();
}
