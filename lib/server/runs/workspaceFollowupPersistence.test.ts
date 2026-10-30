import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PreparingRunAdmissionInput } from "./runRepositoryContract";
import { ActiveRunConflictError } from "./runRepositoryContract";
import { prepareWorkspaceFollowupAdmission } from "./workspaceFollowupPersistence";

type Row = Readonly<{ id: string; subagentTurnId: string | null; workspaceWaitPending: boolean }>;

/** A chat's runs as the admission's query reads them, honouring its `subagentTurnId` filter. */
function client(rows: readonly Row[]) {
  const findMany = vi.fn(async (args: { where: { subagentTurnId?: null } }) =>
    rows.filter((row) => !("subagentTurnId" in args.where) || row.subagentTurnId === args.where.subagentTurnId));
  return { findMany, tx: { modelRun: { findMany } } as unknown as Prisma.TransactionClient };
}

const input = { admissionKind: "NORMAL_SEND", chatId: "chat-1" } as unknown as PreparingRunAdmissionInput;

describe("the send's active-run guard", () => {
  it("admits the user's message while only background sub-agent runs are active in the chat", async () => {
    const { findMany, tx } = client([{ id: "bg-1", subagentTurnId: "turn-1", workspaceWaitPending: false },
      { id: "bg-2", subagentTurnId: "turn-2", workspaceWaitPending: false }]);
    await expect(prepareWorkspaceFollowupAdmission(tx, input, true)).resolves.toBeNull();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ subagentTurnId: null }) }));
  });

  it("still refuses a second main-agent answer", async () => {
    const { tx } = client([{ id: "main-1", subagentTurnId: null, workspaceWaitPending: false },
      { id: "bg-1", subagentTurnId: "turn-1", workspaceWaitPending: false }]);
    await expect(prepareWorkspaceFollowupAdmission(tx, input, true)).rejects.toBeInstanceOf(ActiveRunConflictError);
  });
});
