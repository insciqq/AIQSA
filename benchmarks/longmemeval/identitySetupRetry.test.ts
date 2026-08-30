import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { withLongMemEvalIdentitySetupRetry } from "./identitySetupRetry";

function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("database failure", {
    clientVersion: "test",
    code,
    meta
  });
}

describe("LongMemEval identity setup retry", () => {
  it("retries rollback-safe P2034 conflicts and returns the successful value", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(prismaError("P2034"))
      .mockRejectedValueOnce(prismaError("P2034"))
      .mockResolvedValueOnce("ready");
    const retryDelay = vi.fn(async () => undefined);

    await expect(withLongMemEvalIdentitySetupRetry(operation, { retryDelay }))
      .resolves.toBe("ready");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(retryDelay.mock.calls).toEqual([[1], [2]]);
  });

  it("recognizes PostgreSQL serialization and deadlock codes surfaced by P2010", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(prismaError("P2010", { code: "40001" }))
      .mockRejectedValueOnce(prismaError("P2010", { code: "40P01" }))
      .mockResolvedValueOnce("ready");

    await expect(withLongMemEvalIdentitySetupRetry(operation, {
      retryDelay: async () => undefined
    })).resolves.toBe("ready");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry unrelated database or application failures", async () => {
    const failure = prismaError("P2002");
    const operation = vi.fn().mockRejectedValue(failure);
    const retryDelay = vi.fn(async () => undefined);

    await expect(withLongMemEvalIdentitySetupRetry(operation, { retryDelay }))
      .rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(retryDelay).not.toHaveBeenCalled();
  });

  it("emits a bounded diagnostic after exhausting serialization retries", async () => {
    const operation = vi.fn().mockRejectedValue(prismaError("P2034"));

    await expect(withLongMemEvalIdentitySetupRetry(operation, {
      retryDelay: async () => undefined
    })).rejects.toThrow("longmemeval_identity_setup_serialization_conflict");
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
