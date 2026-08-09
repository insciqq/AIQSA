import type { MemoryScopeState, MemoryScopeType } from "../../contracts/memory";

export type MemoryScopeTargetShape = Readonly<{
  assistantId: string | null;
  chatId: string | null;
  folderId: string | null;
  scopeType: MemoryScopeType;
  state: MemoryScopeState;
  targetIdSnapshot: string | null;
}>;

function nonEmpty(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function memoryScopeTargetShapeIsValid(scope: MemoryScopeTargetShape): boolean {
  const targets = [scope.folderId, scope.assistantId, scope.chatId].filter(nonEmpty);
  if (scope.scopeType === "GLOBAL_USER") {
    return scope.state === "ACTIVE" && scope.targetIdSnapshot === null && targets.length === 0;
  }
  if (!nonEmpty(scope.targetIdSnapshot)) return false;
  if (scope.state !== "ACTIVE") return targets.length === 0;
  if (targets.length !== 1) return false;
  const liveTarget = scope.scopeType === "FOLDER"
    ? scope.folderId
    : scope.scopeType === "ASSISTANT"
      ? scope.assistantId
      : scope.chatId;
  return nonEmpty(liveTarget) && liveTarget === scope.targetIdSnapshot;
}

export function memoryScopeEligibleForRun(
  scope: MemoryScopeTargetShape,
  context: Readonly<{
    assistantId: string | null;
    chatId: string;
    folderId: string | null;
  }>
): boolean {
  if (!memoryScopeTargetShapeIsValid(scope) || scope.state !== "ACTIVE") return false;
  if (scope.scopeType === "GLOBAL_USER") return true;
  if (scope.scopeType === "FOLDER") return scope.folderId !== null && scope.folderId === context.folderId;
  if (scope.scopeType === "ASSISTANT") {
    return scope.assistantId !== null && scope.assistantId === context.assistantId;
  }
  return scope.chatId === context.chatId;
}

export function memoryScopeTransitionAllowed(
  scopeType: MemoryScopeType,
  from: MemoryScopeState,
  to: MemoryScopeState
): boolean {
  if (scopeType === "GLOBAL_USER") return false;
  if (from === "ACTIVE") return to === "ORPHANED" || to === "RETRACTED";
  return from === "ORPHANED" && to === "RETRACTED";
}
