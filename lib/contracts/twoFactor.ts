/** TOTP two-factor wire shapes for `/api/me/two-factor` and `/api/auth/second-factor`. */

export type TwoFactorStatusWire = Readonly<{
  /** False for accounts that only sign in through an identity provider, which owns their MFA. */
  available: boolean;
  enabled: boolean;
  recoveryCodesRemaining: number;
}>;

export type TwoFactorSetupWire = Readonly<{
  otpauthUri: string;
  /** The base32 key for apps that cannot scan; shown while setting up only. */
  secret: string;
}>;

/** A current code that proves the factor before it is replaced, regenerated or turned off. */
export type TwoFactorProofWire = Readonly<{ code: string }> | Readonly<{ recoveryCode: string }>;

export const TWO_FACTOR_ACTIONS = ["start", "confirm", "regenerate-codes", "disable"] as const;

export type TwoFactorAction = (typeof TWO_FACTOR_ACTIONS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function decodeTwoFactorStatus(value: unknown): TwoFactorStatusWire | null {
  if (!isRecord(value) || !isRecord(value.twoFactor)) return null;
  const status = value.twoFactor;
  if (typeof status.available !== "boolean" || typeof status.enabled !== "boolean" || !isCount(status.recoveryCodesRemaining)) {
    return null;
  }
  return {
    available: status.available,
    enabled: status.enabled,
    recoveryCodesRemaining: status.recoveryCodesRemaining
  };
}

export function decodeTwoFactorSetup(value: unknown): TwoFactorSetupWire | null {
  if (!isRecord(value) || typeof value.secret !== "string" || typeof value.otpauthUri !== "string") return null;
  if (!/^[A-Z2-7]{16,128}$/u.test(value.secret) || !value.otpauthUri.startsWith("otpauth://totp/")) return null;
  return { otpauthUri: value.otpauthUri, secret: value.secret };
}

export function decodeRecoveryCodes(value: unknown): string[] | null {
  if (!isRecord(value) || !Array.isArray(value.recoveryCodes) || value.recoveryCodes.length === 0) return null;
  const codes = value.recoveryCodes;
  return codes.every((code): code is string => typeof code === "string" && /^[0-9A-Z]{5}-[0-9A-Z]{5}$/u.test(code))
    ? [...codes]
    : null;
}
