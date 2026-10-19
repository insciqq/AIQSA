import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { revokeAllConnectDevices, revokeConnectDevicesForUser } from "./revocation";

function transaction() {
  const calls: string[] = [];
  const tx = {
    connectDevice: {
      deleteMany: vi.fn(async (args: unknown) => {
        calls.push(`devices:${JSON.stringify(args)}`);
        return { count: 2 };
      })
    },
    connectPairing: {
      deleteMany: vi.fn(async (args: unknown) => {
        calls.push(`pairings:${JSON.stringify(args)}`);
        return { count: 1 };
      })
    }
  };
  return { calls, tx: tx as unknown as Prisma.TransactionClient };
}

describe("AIQSA Connect account revocation", () => {
  it("deletes unconsumed approvals before the devices, then drops the account's streams", async () => {
    const { calls, tx } = transaction();
    const relay = { disconnectUser: vi.fn(() => calls.push("relay")) };

    await expect(revokeConnectDevicesForUser(tx, { userId: "user-1" }, relay)).resolves.toBe(2);

    expect(calls).toEqual([
      `pairings:${JSON.stringify({ where: { approvedUserId: "user-1", consumedAt: null } })}`,
      `devices:${JSON.stringify({ where: { userId: "user-1" } })}`,
      "relay"
    ]);
    expect(relay.disconnectUser).toHaveBeenCalledWith("user-1", "connect_unauthorized");
  });

  it("revokes every device and approval of the installation and ends every stream", async () => {
    const { calls, tx } = transaction();
    const relay = { disconnectAll: vi.fn(() => calls.push("relay")) };

    await expect(revokeAllConnectDevices(tx, relay)).resolves.toBe(2);

    expect(calls).toEqual([
      `pairings:${JSON.stringify({ where: { approvedUserId: { not: null }, consumedAt: null } })}`,
      `devices:${JSON.stringify({})}`,
      "relay"
    ]);
  });

  it("drops nothing in the relay when the store refuses the deletion", async () => {
    const { tx } = transaction();
    (tx.connectDevice.deleteMany as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("lock timeout"));
    const relay = { disconnectUser: vi.fn() };

    await expect(revokeConnectDevicesForUser(tx, { userId: "user-1" }, relay)).rejects.toThrow("lock timeout");
    expect(relay.disconnectUser).not.toHaveBeenCalled();
  });
});
