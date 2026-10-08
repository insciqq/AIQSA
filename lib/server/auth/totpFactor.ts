import type { AuthTotpFactor, Prisma } from "@prisma/client";
import {
  decryptTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  matchTotpStep,
  normalizeRecoveryCode,
  normalizeTotpCode
} from "./totp";

/** The keys TOTP work needs: the encryption key of the secrets and the recovery-code hash key. */
export type TotpKeys = {
  encryptionKey: Buffer;
  recoveryCodeKey: Buffer;
};

/** A typed second factor: a TOTP code or a recovery code, as the user sent it. */
export type SecondFactorAttempt = { code: unknown; kind: "recovery" | "totp" };

declare const secondFactorProofBrand: unique symbol;

/**
 * Evidence that a second factor was verified for this user inside the current transaction.
 * Only `verifySecondFactorAttempt` makes one, so no caller can skip the factor by asserting it.
 */
export type SecondFactorProof = { readonly [secondFactorProofBrand]: true; readonly userId: string };

type FactorRow = Pick<AuthTotpFactor, "confirmedAt" | "lastUsedStep" | "secretEnvelope" | "userId">;

export async function lockTotpFactor(tx: Prisma.TransactionClient, userId: string): Promise<AuthTotpFactor | null> {
  await tx.$queryRaw<Array<{ userId: string }>>`
    SELECT "userId"
    FROM "AuthTotpFactor"
    WHERE "userId" = ${userId}
    FOR UPDATE
  `;

  return tx.authTotpFactor.findUnique({ where: { userId } });
}

/** Creates the user's factor row if it is missing, then locks it. */
export async function lockOrCreateTotpFactor(tx: Prisma.TransactionClient, userId: string, now: Date): Promise<AuthTotpFactor> {
  await tx.$executeRaw`
    INSERT INTO "AuthTotpFactor" ("userId", "updatedAt")
    VALUES (${userId}, ${now})
    ON CONFLICT ("userId") DO NOTHING
  `;
  const factor = await lockTotpFactor(tx, userId);

  if (!factor) {
    throw new Error("totp_factor_missing");
  }

  return factor;
}

/**
 * The confirmed factor's state as one opaque value. Every successful second factor changes it
 * (a later TOTP step or one more used recovery code), and so do a reset and a re-enrolment.
 */
export async function totpFactorBinding(tx: Prisma.TransactionClient, factor: FactorRow): Promise<string | null> {
  if (!factor.confirmedAt || !factor.secretEnvelope) {
    return null;
  }

  const usedRecoveryCodes = await tx.authRecoveryCode.count({
    where: { usedAt: { not: null }, userId: factor.userId }
  });

  return `${factor.confirmedAt.getTime()}:${factor.lastUsedStep?.toString() ?? "-"}:${usedRecoveryCodes}`;
}

/** The confirmed factor's binding for the sign-in seam, or null when the user has no 2FA. */
export async function readTotpFactorBinding(tx: Prisma.TransactionClient, userId: string): Promise<string | null> {
  const factor = await tx.authTotpFactor.findUnique({
    select: { confirmedAt: true, lastUsedStep: true, secretEnvelope: true, userId: true },
    where: { userId }
  });

  return factor ? totpFactorBinding(tx, factor) : null;
}

/**
 * Checks a TOTP code (with the replay guard) or spends a recovery code against the user's
 * confirmed factor, which the caller has locked. Success records the used step or code in the
 * caller's transaction and returns the proof; anything else returns null and changes nothing.
 */
export async function verifySecondFactorAttempt(
  tx: Prisma.TransactionClient,
  input: { attempt: SecondFactorAttempt; factor: FactorRow; keys: TotpKeys; now: Date }
): Promise<SecondFactorProof | null> {
  const { factor } = input;

  if (!factor.confirmedAt || !factor.secretEnvelope) {
    return null;
  }

  if (input.attempt.kind === "totp") {
    const code = normalizeTotpCode(input.attempt.code);

    if (!code) {
      return null;
    }

    const step = matchTotpStep({
      code,
      lastUsedStep: factor.lastUsedStep === null ? null : Number(factor.lastUsedStep),
      now: input.now,
      secret: decryptTotpSecret({ envelope: factor.secretEnvelope, key: input.keys.encryptionKey, userId: factor.userId })
    });

    if (step === null) {
      return null;
    }

    await tx.authTotpFactor.update({ data: { lastUsedStep: BigInt(step) }, where: { userId: factor.userId } });
  } else {
    const code = normalizeRecoveryCode(input.attempt.code);

    if (!code) {
      return null;
    }

    const spent = await tx.authRecoveryCode.updateMany({
      data: { usedAt: input.now },
      where: {
        codeHash: hashRecoveryCode({ code, key: input.keys.recoveryCodeKey, userId: factor.userId }),
        usedAt: null,
        userId: factor.userId
      }
    });

    if (spent.count !== 1) {
      return null;
    }
  }

  return { userId: factor.userId } as SecondFactorProof;
}

/** Replaces every recovery code of the user's factor and returns the new codes, once. */
export async function replaceRecoveryCodes(
  tx: Prisma.TransactionClient,
  input: { keys: TotpKeys; userId: string }
): Promise<string[]> {
  const codes = generateRecoveryCodes();

  await tx.authRecoveryCode.deleteMany({ where: { userId: input.userId } });
  await tx.authRecoveryCode.createMany({
    data: codes.map((code) => ({
      codeHash: hashRecoveryCode({ code: normalizeRecoveryCode(code)!, key: input.keys.recoveryCodeKey, userId: input.userId }),
      userId: input.userId
    }))
  });

  return codes;
}
