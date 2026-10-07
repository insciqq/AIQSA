import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { encryptProviderCredentialSecret } from "../providers/credentialSecrets";
import type { SpeechToTextDb } from "./role";

/** Test-only in-memory stand-in for the Prisma subset the dictation role reads and writes. */
export const TEST_ENCRYPTION_KEY = randomBytes(32);

type Connection = { id: string; displayName: string; family: string; enabled: boolean; activeVersion: number;
  activeConfig: unknown; defaultCredentialId: string | null };
type Version = { id: string; credentialId: string; revokedAt: Date | null; secretEnvelope: string | null; testEvidence: unknown };
type Credential = { id: string; connectionId: string; enabled: boolean; activeVersionId: string | null };
type Policy = { speechToTextConnectionId: string | null; speechToTextModelId: string | null;
  speechToTextCredentialVersionId: string | null; speechToTextConfiguredAt: Date | null; updatedByUserId: string | null };

export function createSpeechToTextTestDb() {
  const connections = new Map<string, Connection>();
  const credentials = new Map<string, Credential>();
  const versions = new Map<string, Version>();
  const usage: Prisma.UsageEventUncheckedCreateInput[] = [];
  const policy: Policy = { speechToTextConfiguredAt: null, speechToTextConnectionId: null, speechToTextCredentialVersionId: null,
    speechToTextModelId: null, updatedByUserId: null };

  function addConnection(input: Partial<Connection> & { id: string; secret?: string | null; family?: string }) {
    const noAuth = input.secret === null;
    const connection: Connection = {
      activeConfig: noAuth
        ? { allowPrivateNetwork: true, apiRoot: "http://127.0.0.1:9000/v1", authenticationMode: "none", responseTimeoutMs: 30_000 }
        : { allowPrivateNetwork: false, apiRoot: "https://stt.example.test/v1", authenticationMode: "bearer", responseTimeoutMs: 30_000 },
      activeVersion: 1, defaultCredentialId: `${input.id}-key`, displayName: `Connection ${input.id}`, enabled: true,
      family: input.family ?? "openai_compatible", ...input
    };
    connections.set(connection.id, connection);
    const credentialId = `${input.id}-key`;
    const versionId = `${input.id}-key-v1`;
    credentials.set(credentialId, { activeVersionId: versionId, connectionId: connection.id, enabled: true, id: credentialId });
    versions.set(versionId, { credentialId, id: versionId, revokedAt: null,
      secretEnvelope: noAuth ? null : encryptProviderCredentialSecret({ credentialId, key: TEST_ENCRYPTION_KEY, secret: input.secret ?? "secret-key", valueId: versionId }),
      testEvidence: { authenticationMode: noAuth ? "none" : "bearer" } });
    return { credentialId, versionId };
  }

  function rotateKey(connectionId: string) {
    const credentialId = `${connectionId}-key`;
    const versionId = `${connectionId}-key-v2`;
    versions.set(versionId, { credentialId, id: versionId, revokedAt: null,
      secretEnvelope: encryptProviderCredentialSecret({ credentialId, key: TEST_ENCRYPTION_KEY, secret: "rotated", valueId: versionId }),
      testEvidence: { authenticationMode: "bearer" } });
    credentials.get(credentialId)!.activeVersionId = versionId;
  }

  const pick = <T extends Record<string, unknown>>(row: T, select: Record<string, unknown> | undefined) =>
    select ? Object.fromEntries(Object.keys(select).filter((key) => key in row).map((key) => [key, row[key]])) : row;

  const db = {
    providerConnection: {
      async findUnique({ select, where }: { select?: Record<string, unknown>; where: { id: string } }) {
        const row = connections.get(where.id);
        return row ? pick(row, select) : null;
      },
      async findMany({ where }: { where: { family: { in: string[] } } }) {
        return [...connections.values()].filter((row) => row.enabled && row.activeVersion > 0 && where.family.in.includes(row.family))
          .sort((left, right) => left.displayName.localeCompare(right.displayName));
      }
    },
    providerCredential: {
      async findFirst({ where }: { where: { id: string; connectionId: string } }) {
        const row = credentials.get(where.id);
        if (!row || row.connectionId !== where.connectionId) return null;
        return { activeVersion: row.activeVersionId ? versions.get(row.activeVersionId) ?? null : null, enabled: row.enabled, id: row.id };
      }
    },
    providerCredentialVersion: {
      async findFirst({ where }: { where: { id: string; credentialId: string } }) {
        const row = versions.get(where.id);
        return row && row.credentialId === where.credentialId ? row : null;
      }
    },
    systemModelPolicy: {
      async findUnique() {
        return { ...policy };
      },
      async updateMany({ data, where }: { data: Partial<Policy>; where: { speechToTextConfiguredAt: Date | null } }) {
        const current = policy.speechToTextConfiguredAt?.getTime() ?? null;
        if (current !== (where.speechToTextConfiguredAt?.getTime() ?? null)) return { count: 0 };
        Object.assign(policy, data);
        return { count: 1 };
      }
    },
    usageEvent: {
      async create({ data }: { data: Prisma.UsageEventUncheckedCreateInput }) {
        usage.push(data);
        return { id: `usage-${usage.length}` };
      }
    }
  };

  return {
    addConnection,
    connections,
    credentials,
    db: db as unknown as SpeechToTextDb & Pick<import("@prisma/client").PrismaClient, "usageEvent">,
    policy,
    rotateKey,
    usage,
    versions
  };
}
