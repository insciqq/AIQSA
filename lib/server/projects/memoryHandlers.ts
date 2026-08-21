import type { RequestAuthResolver } from "../auth/requestAuth";
import type { ReturnTypeOfProjectMemoryRepository } from "./memoryRepository";

export type ProjectMemoryHandlerDeps = Readonly<{
  repository: ReturnTypeOfProjectMemoryRepository;
  resolveAuth: RequestAuthResolver;
}>;

type RouteContext<Keys extends string> = {
  params: Promise<Record<Keys, string>> | Record<Keys, string>;
};

function unavailable(): Response {
  return Response.json({ error: "project_memory_unavailable" }, { status: 404 });
}

function dormantProjectMemoryHandler<Keys extends string>() {
  return async function projectMemoryUnavailable(
    _request: Request,
    _context: RouteContext<Keys>
  ): Promise<Response> {
    return unavailable();
  };
}

/**
 * Project Memory data and repository code remain intact, but Personal Memory
 * v1 exposes no authenticated Project Memory product surface. Every legacy
 * route fails closed before auth, parsing, repository access, or mutation.
 */
export function createProjectMemoryListHandler(_deps: ProjectMemoryHandlerDeps) {
  return dormantProjectMemoryHandler<"projectId">();
}

export function createProjectMemoryProposalHandler(_deps: ProjectMemoryHandlerDeps) {
  return dormantProjectMemoryHandler<"projectId">();
}

export function createProjectMemoryFactHandler(_deps: ProjectMemoryHandlerDeps) {
  return dormantProjectMemoryHandler<"projectId">();
}

export function createProjectMemoryReviewHandler(
  _deps: ProjectMemoryHandlerDeps,
  _approve: boolean
) {
  return dormantProjectMemoryHandler<"projectId" | "proposalId">();
}

export function createProjectMemoryFactUpdateHandler(_deps: ProjectMemoryHandlerDeps) {
  return dormantProjectMemoryHandler<"factId" | "projectId">();
}

export function createProjectMemoryFactDeleteHandler(_deps: ProjectMemoryHandlerDeps) {
  return dormantProjectMemoryHandler<"factId" | "projectId">();
}
