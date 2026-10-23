import type { PrismaClient } from "@prisma/client";
import type { WorkspaceSecretKind } from "@/lib/contracts/workspaceSecrets";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import { decryptWorkspaceSecret, type AcceptedWorkspaceSecret } from "./store";
import { WorkspaceSecretError } from "./validation";

/**
 * A readable secret's metadata; names, environment names and the value's
 * stored size are kept unencrypted beside the value. The size decides which
 * Workspace variables a text secret gives (`workspaceSecretVariables`).
 */
export type RunSecretEntry = Readonly<{
  byteSize: number;
  description: string;
  envNames: readonly string[];
  kind: WorkspaceSecretKind;
  name: string;
  valueId: string;
}>;

export type RunSecretScope = Readonly<{ runId: string; userId: string }>;

/**
 * The saved secrets one run may read, for `read_secret` in any chat, with or
 * without a Workspace VM.
 * - A run whose admission bound secret revisions (a Workspace-enabled run)
 *   reads exactly those revisions, the ones its guest receives.
 * - A run without a Workspace binding reads the owner's current revisions.
 * The run must belong to the caller and the caller must be active. Only the
 * value that is read is decrypted.
 */
export type RunSecretSource = Readonly<{
  list(scope: RunSecretScope): Promise<readonly RunSecretEntry[]>;
  read(scope: RunSecretScope & Readonly<{ valueId: string }>): Promise<AcceptedWorkspaceSecret>;
}>;

type RunSecretsPrisma = Pick<PrismaClient, "modelRun" | "user" | "workspaceRunSecret" | "workspaceSecret" | "workspaceSecretValue">;

const entrySelect = { byteSize: true, description: true, envNames: true, id: true, kind: true, name: true } as const;

export function createRunSecretSource(prisma: RunSecretsPrisma, key: () => Buffer = getSecretEncryptionKey): RunSecretSource {
  async function list(scope: RunSecretScope): Promise<readonly RunSecretEntry[]> {
    const owner = await prisma.user.findFirst({ select: { id: true }, where: { id: scope.userId, status: "active" } });
    if (!owner) throw new WorkspaceSecretError("workspace_secret_unavailable");
    const run = await prisma.modelRun.findFirst({
      select: { chat: { select: { userId: true } }, workspaceRunBinding: { select: { modelRunId: true } } },
      where: { id: scope.runId, userId: scope.userId }
    });
    if (!run || run.chat.userId !== scope.userId) throw new WorkspaceSecretError("workspace_secret_unavailable");
    // A bound run lists its revisions in the order the Workspace receives them (`personalSecrets`).
    const rows: readonly Readonly<{ value: Readonly<{ byteSize: number; description: string; envNames: string[]; id: string; kind: string; name: string }> }>[] = run.workspaceRunBinding
      ? await prisma.workspaceRunSecret.findMany({ select: { value: { select: entrySelect } }, where: { modelRunId: scope.runId }, orderBy: { secretId: "asc" } })
      : await prisma.workspaceSecret.findMany({ select: { value: { select: entrySelect } }, where: { userId: scope.userId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    return rows.map(({ value }) => ({
      byteSize: value.byteSize, description: value.description, envNames: value.envNames, kind: value.kind as WorkspaceSecretKind,
      name: value.name, valueId: value.id
    }));
  }
  return {
    list,
    async read(scope) {
      if (!(await list(scope)).some((entry) => entry.valueId === scope.valueId)) throw new WorkspaceSecretError("workspace_secret_unavailable");
      const value = await prisma.workspaceSecretValue.findUnique({ where: { id: scope.valueId } });
      if (!value) throw new WorkspaceSecretError("workspace_secret_unavailable");
      return decryptWorkspaceSecret(value, scope.userId, key());
    }
  };
}
