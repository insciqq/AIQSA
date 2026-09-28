import { Prisma } from "@prisma/client";
import { decodeAssistantIdentity, type AssistantIdentity } from "../../contracts/assistants";

/*
 * Whether an Assistant may be bound to a chat or saved as a default. A
 * personal binding needs the Assistant to be the user's own or published to
 * them (installation, or a group publication in a live group they belong to);
 * a Project chat needs the Assistant bound to that Project, which is its own
 * authority. An archived Assistant is never available. The rule mirrors the
 * access entry of the Assistant repository and the run provenance checks; it
 * is one SQL predicate here so that a missing, foreign or archived Assistant
 * runs the same statement and yields the same empty result.
 */

export type AssistantBindingScope =
  | Readonly<{ kind: "personal"; userId: string }>
  | Readonly<{ kind: "project"; projectId: string }>;

export type AssistantBindingAccessClient = Pick<Prisma.TransactionClient, "$queryRaw">;

function availableTo(scope: AssistantBindingScope): Prisma.Sql {
  if (scope.kind === "project") {
    return Prisma.sql`EXISTS (
      SELECT 1 FROM "ProjectAssistantBinding" AS project_binding
      WHERE project_binding."assistantId" = definition."id"
        AND project_binding."projectId" = ${scope.projectId}
    )`;
  }
  return Prisma.sql`(
    definition."ownerUserId" = ${scope.userId}
    OR EXISTS (
      SELECT 1 FROM "AssistantPublication" AS publication
      WHERE publication."assistantId" = definition."id"
        AND publication."scope" = 'installation'
    )
    OR EXISTS (
      SELECT 1 FROM "AssistantPublication" AS publication
      INNER JOIN "UserGroup" AS membership
        ON membership."groupId" = publication."groupId"
       AND membership."userId" = ${scope.userId}
      INNER JOIN "Group" AS member_group
        ON member_group."id" = membership."groupId"
       AND member_group."archivedAt" IS NULL
      WHERE publication."assistantId" = definition."id"
        AND publication."scope" = 'group'
    )
  )`;
}

/**
 * Checks availability inside the caller's transaction. With `lock`, the
 * definition row is held FOR KEY SHARE until the transaction ends, so a
 * concurrent deletion waits instead of breaking a foreign key the caller is
 * about to write. Callers that also lock a chat, Project or settings row take
 * this lock first, in the same order as Assistant deletion.
 */
export async function isAssistantAvailable(
  client: AssistantBindingAccessClient,
  input: Readonly<{ assistantId: string; lock?: boolean; scope: AssistantBindingScope }>
): Promise<boolean> {
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT definition."id"
    FROM "AssistantDefinition" AS definition
    WHERE definition."id" = ${input.assistantId}
      AND definition."archivedAt" IS NULL
      AND ${availableTo(input.scope)}
    ${input.lock ? Prisma.sql`FOR KEY SHARE OF definition` : Prisma.empty}
  `);
  return rows.length === 1;
}

/**
 * Whether the Assistant is archived and would otherwise be available in the
 * scope. A consumer who still has an archived Assistant may learn that its
 * owner archived it, and nothing more; a missing, foreign or unarchived
 * Assistant runs the same statement and yields false.
 */
export async function isAssistantArchivedFor(
  client: AssistantBindingAccessClient,
  input: Readonly<{ assistantId: string; scope: AssistantBindingScope }>
): Promise<boolean> {
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT definition."id"
    FROM "AssistantDefinition" AS definition
    WHERE definition."id" = ${input.assistantId}
      AND definition."archivedAt" IS NOT NULL
      AND ${availableTo(input.scope)}
  `);
  return rows.length === 1;
}

/**
 * Display identities of the Assistants in `assistantIds` that are currently
 * available to the user, in one statement; unavailable ones are absent.
 */
export async function availableAssistantIdentities(
  client: AssistantBindingAccessClient,
  input: Readonly<{ assistantIds: readonly string[]; userId: string }>
): Promise<Map<string, AssistantIdentity>> {
  const ids = [...new Set(input.assistantIds)];
  if (ids.length === 0) return new Map();
  const rows = await client.$queryRaw<Array<{ avatar: unknown; id: string; name: string }>>(Prisma.sql`
    SELECT definition."id", definition."name", definition."avatar"
    FROM "AssistantDefinition" AS definition
    WHERE definition."id" IN (${Prisma.join(ids)})
      AND definition."archivedAt" IS NULL
      AND ${availableTo({ kind: "personal", userId: input.userId })}
  `);
  const identities = new Map<string, AssistantIdentity>();
  for (const row of rows) {
    const identity = decodeAssistantIdentity({ avatar: row.avatar, name: row.name });
    if (identity) identities.set(row.id, identity);
  }
  return identities;
}
