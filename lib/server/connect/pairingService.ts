import {
  CONNECT_CONTROL_CHARACTER_PATTERN,
  CONNECT_MAX_ACCOUNT_LABEL_LENGTH,
  CONNECT_PAIRING_POLL_INTERVAL_SECONDS,
  CONNECT_PAIRING_TTL_SECONDS,
  connectPairPagePath,
  normalizeConnectUserCode,
  type ConnectPairingCreateRequest,
  type ConnectPairingCreateResponse,
  type ConnectPairingDecision,
  type ConnectPairingLookupResponse,
  type ConnectPairingPollRequest,
  type ConnectPairingPollResponse
} from "@/lib/contracts/connect";
import { verifyTokenHash } from "../auth/token";
import { logConnect } from "./observability";
import type { ConnectRelay } from "./relay";
import type { ConnectPairingAccount, ConnectPairingApproval, ConnectPairingRecord, ConnectRepository } from "./repository";
import {
  generateConnectUserCode,
  hashConnectUserCode,
  issueConnectDeviceToken,
  issueConnectPollSecret
} from "./tokens";

const CODE_ATTEMPTS = 4;
const CONTROL_CHARACTERS = new RegExp(CONNECT_CONTROL_CHARACTER_PATTERN.source, "gu");

/**
 * Who approved a pairing, as the computer's `login` prints it: the display name and the email with
 * its local part masked ("Ann (a•••@example.com)"), so the owner notices a code someone else approved.
 */
export function connectAccountLabel(account: ConnectPairingAccount): string {
  const name = account.displayName.replace(CONTROL_CHARACTERS, "").trim() || "AIQSA account";
  const email = account.email?.replace(CONTROL_CHARACTERS, "") ?? "";
  const at = email.lastIndexOf("@");
  const label = at > 0 ? `${name} (${Array.from(email)[0]}•••${email.slice(at)})` : name;
  return Array.from(label).slice(0, CONNECT_MAX_ACCOUNT_LABEL_LENGTH).join("");
}

export type ConnectPairingService = ReturnType<typeof createConnectPairingService>;

function pending(pairing: ConnectPairingRecord | null, now: Date): pairing is ConnectPairingRecord {
  return pairing !== null && pairing.approvedUserId === null && pairing.deniedAt === null &&
    pairing.consumedAt === null && pairing.expiresAt > now;
}

/**
 * Device pairing by code: the computer creates a pairing and polls with its
 * secret; the signed-in owner looks the code up and approves or denies it.
 * The device token exists only in the one poll response that consumes the
 * approval. Unknown, expired, consumed and decided codes look alike.
 */
export function createConnectPairingService(deps: Readonly<{
  codeSecret: () => string;
  now?: () => Date;
  /** The canonical origin of this installation, for the approval link. */
  origin: () => string;
  relay: Pick<ConnectRelay, "notifyDevicesChanged">;
  repository: Pick<ConnectRepository,
    "approvePairing" | "consumePairing" | "createPairing" | "denyPairing" | "findPairing" | "findPairingByCode">;
}>) {
  const clock = deps.now ?? (() => new Date());

  function codeHash(userCode: string): string | null {
    const normalized = normalizeConnectUserCode(userCode);
    return normalized ? hashConnectUserCode(normalized, deps.codeSecret()) : null;
  }

  return {
    async create(request: ConnectPairingCreateRequest): Promise<ConnectPairingCreateResponse> {
      const now = clock();
      const expiresAt = new Date(now.getTime() + CONNECT_PAIRING_TTL_SECONDS * 1000);
      const secret = deps.codeSecret();
      const origin = deps.origin();
      for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
        const userCode = generateConnectUserCode();
        const pollSecret = issueConnectPollSecret();
        const created = await deps.repository.createPairing({
          arch: request.arch,
          clientVersion: request.clientVersion,
          createdAt: now,
          expiresAt,
          hostname: request.hostname,
          name: request.name,
          os: request.os,
          pollSecretHash: pollSecret.hash,
          userCodeHash: hashConnectUserCode(userCode, secret)
        });
        if (!created) continue;
        return {
          expiresAt: expiresAt.toISOString(),
          intervalSeconds: CONNECT_PAIRING_POLL_INTERVAL_SECONDS,
          pairingId: created.id,
          pollSecret: pollSecret.value,
          userCode,
          verificationUri: `${origin}${connectPairPagePath(userCode)}`
        };
      }
      throw new Error("connect_user_code_unavailable");
    },

    /** `device_limit` when the approving account filled its devices meanwhile; the approval waits for expiry. */
    async poll(request: ConnectPairingPollRequest): Promise<ConnectPairingPollResponse | "device_limit"> {
      const now = clock();
      const pairing = await deps.repository.findPairing(request.pairingId);
      if (!pairing || !verifyTokenHash(request.pollSecret, pairing.pollSecretHash)) return { status: "expired" };
      if (pairing.consumedAt !== null) return { status: "expired" };
      if (pairing.deniedAt !== null) return { status: "denied" };
      if (pairing.expiresAt <= now) return { status: "expired" };
      if (pairing.approvedUserId === null) return { status: "pending" };
      const token = issueConnectDeviceToken();
      const consumed = await deps.repository.consumePairing({ id: pairing.id, now, tokenHash: token.hash });
      if (consumed.kind === "device_limit") return "device_limit";
      if (consumed.kind === "unavailable") return { status: "expired" };
      logConnect({ code: "connect_device_paired", outcome: "completed", stage: "write" });
      deps.relay.notifyDevicesChanged(consumed.userId);
      return {
        account: connectAccountLabel(consumed.account),
        deviceId: consumed.deviceId,
        deviceToken: token.value,
        status: "approved"
      };
    },

    /** The computer behind a pending code, for the approval page; null for every other code. */
    async lookup(userCode: string): Promise<ConnectPairingLookupResponse | null> {
      const hash = codeHash(userCode);
      if (!hash) return null;
      const pairing = await deps.repository.findPairingByCode(hash);
      if (!pending(pairing, clock())) return null;
      return {
        pairing: {
          arch: pairing.arch,
          clientVersion: pairing.clientVersion,
          expiresAt: pairing.expiresAt.toISOString(),
          hostname: pairing.hostname,
          name: pairing.name,
          os: pairing.os
        }
      };
    },

    /** Approval binds the pairing to the signed-in account; both decisions need a pending code. */
    async decide(input: Readonly<{
      authSessionId: string;
      decision: ConnectPairingDecision;
      userCode: string;
      userId: string;
    }>): Promise<ConnectPairingApproval | "denied"> {
      const hash = codeHash(input.userCode);
      if (!hash) return "expired";
      const now = clock();
      if (input.decision === "deny") return deps.repository.denyPairing({ now, userCodeHash: hash });
      return deps.repository.approvePairing({ authSessionId: input.authSessionId, now, userCodeHash: hash, userId: input.userId });
    }
  };
}
