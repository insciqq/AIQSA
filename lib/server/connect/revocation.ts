import type { Prisma } from "@prisma/client";
import { getConnectRelay, type ConnectRelay } from "./relay";

/**
 * Ends an account's AIQSA Connect access inside the caller's account-security
 * transaction: approvals not yet consumed go first, so a pairing consumed
 * concurrently has created its device before the devices are deleted. The
 * relay then drops the account's streams and views at once. It runs before
 * the commit, so a rolled-back revocation may still have disconnected
 * clients; stream opens wait for the deleted rows and see them gone.
 */
export async function revokeConnectDevicesForUser(
  tx: Prisma.TransactionClient,
  input: Readonly<{ userId: string }>,
  relay: Pick<ConnectRelay, "disconnectUser"> = getConnectRelay()
): Promise<number> {
  await tx.connectPairing.deleteMany({ where: { approvedUserId: input.userId, consumedAt: null } });
  const deleted = await tx.connectDevice.deleteMany({ where: { userId: input.userId } });
  relay.disconnectUser(input.userId, "connect_unauthorized");
  return deleted.count;
}

/** The installation-wide variant for the administrator's revoke-all-sessions action. */
export async function revokeAllConnectDevices(
  tx: Prisma.TransactionClient,
  relay: Pick<ConnectRelay, "disconnectAll"> = getConnectRelay()
): Promise<number> {
  await tx.connectPairing.deleteMany({ where: { approvedUserId: { not: null }, consumedAt: null } });
  const deleted = await tx.connectDevice.deleteMany({});
  relay.disconnectAll();
  return deleted.count;
}
