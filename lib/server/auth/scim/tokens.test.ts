import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { hashToken } from "../token";
import { createPrismaScimTokenRepository, isScimTokenFormat, issueScimToken } from "./tokens";

const now = new Date("2026-10-08T12:00:00.000Z");

function fakePrisma(row: { id: string; revokedAt: Date | null; tokenHash: string } | null) {
  const findUnique = vi.fn(async () => row);
  const updateMany = vi.fn(async () => ({ count: 1 }));
  return {
    findUnique,
    prisma: { authScimToken: { findUnique, updateMany } } as unknown as PrismaClient,
    updateMany
  };
}

describe("SCIM tokens", () => {
  it("issues 256-bit tokens with a recognizable prefix, stored only as a hash", () => {
    const first = issueScimToken();
    const second = issueScimToken();

    expect(first.token).toMatch(/^aiqsa_scim_[A-Za-z0-9_-]{43}$/u);
    expect(first.token).not.toBe(second.token);
    expect(first.displayPrefix).toBe(first.token.slice(0, 15));
    expect(first.tokenHash).toBe(hashToken(first.token));
    expect(first.tokenHash).not.toContain(first.token.slice(11));
    expect(isScimTokenFormat(first.token)).toBe(true);
    expect(isScimTokenFormat(`${first.token}x`)).toBe(false);
    expect(isScimTokenFormat("Bearer aiqsa_scim_")).toBe(false);
  });

  it("authenticates a current token by its hash and refuses revoked or malformed ones", async () => {
    const issued = issueScimToken();
    const current = fakePrisma({ id: "token-1", revokedAt: null, tokenHash: issued.tokenHash });

    await expect(createPrismaScimTokenRepository(current.prisma).authenticate(issued.token, now)).resolves.toBe(true);
    expect(current.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tokenHash: issued.tokenHash } }));
    // lastUsedAt moves at a one-minute resolution and never on a revoked row.
    expect(current.updateMany).toHaveBeenCalledWith({
      data: { lastUsedAt: now },
      where: {
        id: "token-1",
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - 60_000) } }],
        revokedAt: null
      }
    });

    const revoked = fakePrisma({ id: "token-2", revokedAt: now, tokenHash: issued.tokenHash });
    await expect(createPrismaScimTokenRepository(revoked.prisma).authenticate(issued.token, now)).resolves.toBe(false);
    expect(revoked.updateMany).not.toHaveBeenCalled();

    const unknown = fakePrisma(null);
    await expect(createPrismaScimTokenRepository(unknown.prisma).authenticate(issued.token, now)).resolves.toBe(false);
    await expect(createPrismaScimTokenRepository(unknown.prisma).authenticate("aiqsa_scim_short", now)).resolves.toBe(false);
    expect(unknown.findUnique).toHaveBeenCalledTimes(1);
  });
});
