import type { PrismaClient } from "@prisma/client";
import {
  SPEECH_TO_TEXT_PROVIDER_FAMILIES,
  isSpeechToTextModelId,
  type AdminSpeechToTextConnection,
  type AdminSpeechToTextRole,
  type SpeechToTextTestFailure
} from "../../contracts/speechToText";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import {
  AudioTranscriptionError,
  createAudioTranscriptionAdapter,
  type AudioTranscriptionUsage
} from "../providers/audioTranscription";
import { discoverTranscriptionModels, TranscriptionModelDiscoveryError } from "../providers/transcriptionModelDiscovery";
import { speechToTextProbeSample } from "./probeSample";
import {
  SPEECH_TO_TEXT_POLICY_ID,
  SpeechToTextCredentialRevokedError,
  isSpeechToTextFamily,
  resolveSpeechToTextConnection,
  resolveSpeechToTextRole,
  type SpeechToTextConnectionBinding,
  type SpeechToTextDb
} from "./role";
import { transcriptionUsageEvent } from "./usage";

export type SpeechToTextAdminErrorCode =
  | "speech_to_text_connection_unavailable"
  | "speech_to_text_discovery_failed"
  | "speech_to_text_discovery_unauthorized"
  | "speech_to_text_model_invalid"
  | "speech_to_text_stale"
  | "speech_to_text_test_failed";

export class SpeechToTextAdminError extends Error {
  constructor(readonly code: SpeechToTextAdminErrorCode, readonly reason: SpeechToTextTestFailure | null = null) {
    super(code);
    this.name = "SpeechToTextAdminError";
  }
}

type AdminDb = SpeechToTextDb & Pick<PrismaClient, "usageEvent">;

const CONNECTION_LIST_LIMIT = 256;

function testFailure(error: unknown): SpeechToTextTestFailure {
  if (error instanceof SpeechToTextCredentialRevokedError) return "unauthorized";
  if (!(error instanceof AudioTranscriptionError)) return "unreachable";
  switch (error.code) {
    case "transcription_provider_http_error": {
      const status = error.httpStatus ?? 0;
      if (status === 401 || status === 403) return "unauthorized";
      return status === 408 || status === 429 || status >= 500 ? "unreachable" : "rejected";
    }
    case "transcription_request_timed_out": return "timed_out";
    case "transcription_response_invalid":
    case "transcription_response_too_large": return "invalid_response";
    default: return "unreachable";
  }
}

/**
 * Control Center → Defaults & roles → Speech to text. The role stores a
 * connection and an upstream model id (no ProviderModel row, no new model
 * class). Candidates come from live discovery with the connection's own key;
 * only a passing Test with the bundled synthetic sample saves, binding the
 * tested default-key version. The role's own `configuredAt` fences its saves,
 * so other role rows keep their versions.
 */
export function createSpeechToTextAdminService(input: Readonly<{
  db: AdminDb;
  encryptionKey?: () => Buffer;
  /** Test transport override; production uses each connection's pinned safe fetch. */
  fetchFn?: typeof fetch;
  now?: () => Date;
}>) {
  const db = input.db;
  const now = input.now ?? (() => new Date());
  const options = input.encryptionKey ? { encryptionKey: input.encryptionKey } : {};

  async function currentConfiguredAt(): Promise<string | null> {
    const policy = await db.systemModelPolicy.findUnique({ select: { speechToTextConfiguredAt: true }, where: { id: SPEECH_TO_TEXT_POLICY_ID } });
    return policy?.speechToTextConfiguredAt?.toISOString() ?? null;
  }

  async function bindingFor(connectionId: string): Promise<SpeechToTextConnectionBinding> {
    const resolved = await resolveSpeechToTextConnection(db, connectionId, options);
    if (!resolved.ok) throw new SpeechToTextAdminError("speech_to_text_connection_unavailable");
    return resolved.binding;
  }

  /** Writes the role only while its configuration is still the one the administrator saw. */
  async function guardedWrite(expectedConfiguredAt: string | null, data: Readonly<{
    speechToTextConnectionId: string | null;
    speechToTextCredentialVersionId: string | null;
    speechToTextModelId: string | null;
  }>, userId: string): Promise<void> {
    const expected = expectedConfiguredAt === null ? null : new Date(expectedConfiguredAt);
    if (expected !== null && !Number.isFinite(expected.getTime())) throw new SpeechToTextAdminError("speech_to_text_stale");
    const written = await db.systemModelPolicy.updateMany({
      data: { ...data, speechToTextConfiguredAt: now(), updatedByUserId: userId },
      where: { id: SPEECH_TO_TEXT_POLICY_ID, speechToTextConfiguredAt: expected }
    });
    if (written.count !== 1) throw new SpeechToTextAdminError("speech_to_text_stale");
  }

  async function recordCheckUsage(binding: SpeechToTextConnectionBinding, modelId: string, usage: AudioTranscriptionUsage | null, userId: string) {
    try {
      await db.usageEvent.create({ data: transcriptionUsageEvent({ family: binding.family, modelId, purpose: "model_check", usage, userId }) });
    } catch (error) {
      // A lost row is logged content-free and never retried, so no call is charged twice.
      logEvent("service_operation", { subsystem: "dictation", stage: "settle", outcome: "failed",
        code: "speech_to_text_usage_unrecorded", prisma_code: databaseFailureCode(error) });
    }
  }

  return Object.freeze({
    async read(): Promise<AdminSpeechToTextRole> {
      const [policy, rows] = await Promise.all([
        db.systemModelPolicy.findUnique({
          select: { speechToTextConfiguredAt: true, speechToTextConnectionId: true, speechToTextModelId: true },
          where: { id: SPEECH_TO_TEXT_POLICY_ID }
        }),
        db.providerConnection.findMany({
          orderBy: [{ displayName: "asc" }, { id: "asc" }],
          select: { displayName: true, family: true, id: true },
          take: CONNECTION_LIST_LIMIT,
          where: { activeVersion: { gt: 0 }, enabled: true, family: { in: [...SPEECH_TO_TEXT_PROVIDER_FAMILIES] } }
        })
      ]);
      const connections: AdminSpeechToTextConnection[] = [];
      for (const row of rows) {
        if (!isSpeechToTextFamily(row.family)) continue;
        const resolved = await resolveSpeechToTextConnection(db, row.id, options);
        connections.push({ displayName: row.displayName, family: row.family, id: row.id, ready: resolved.ok });
      }
      let assignment: AdminSpeechToTextRole["assignment"] = null;
      if (policy?.speechToTextConnectionId && policy.speechToTextModelId) {
        const [role, connection] = await Promise.all([
          resolveSpeechToTextRole(db, options),
          db.providerConnection.findUnique({ select: { displayName: true }, where: { id: policy.speechToTextConnectionId } })
        ]);
        assignment = {
          available: role.ok,
          connectionDisplayName: connection?.displayName ?? null,
          connectionId: policy.speechToTextConnectionId,
          modelId: policy.speechToTextModelId,
          unavailableReason: role.ok ? null : role.reason === "not_configured" ? "connection_unavailable" : role.reason
        };
      }
      return { assignment, configuredAt: policy?.speechToTextConfiguredAt?.toISOString() ?? null, connections };
    },

    async discover(request: Readonly<{ connectionId: string; signal?: AbortSignal }>): Promise<string[]> {
      const binding = await bindingFor(request.connectionId);
      try {
        return await discoverTranscriptionModels({
          connection: binding.connection, family: binding.family, secret: binding.secret,
          ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
          ...(request.signal ? { signal: request.signal } : {})
        });
      } catch (error) {
        if (request.signal?.aborted) throw error;
        throw new SpeechToTextAdminError(error instanceof TranscriptionModelDiscoveryError &&
          error.code === "transcription_discovery_unauthorized" || error instanceof SpeechToTextCredentialRevokedError
          ? "speech_to_text_discovery_unauthorized" : "speech_to_text_discovery_failed");
      }
    },

    /** One paid call with the synthetic sample, billed as `model_check` to the administrator; saves only on success. */
    async testAndSave(request: Readonly<{
      connectionId: string;
      expectedConfiguredAt: string | null;
      modelId: string;
      signal?: AbortSignal;
      userId: string;
    }>): Promise<void> {
      if (!isSpeechToTextModelId(request.modelId)) throw new SpeechToTextAdminError("speech_to_text_model_invalid");
      if (await currentConfiguredAt() !== request.expectedConfiguredAt) throw new SpeechToTextAdminError("speech_to_text_stale");
      const binding = await bindingFor(request.connectionId);
      const adapter = createAudioTranscriptionAdapter({
        connection: binding.connection, providerFamily: binding.family, secret: binding.secret,
        upstreamModelId: request.modelId, ...(input.fetchFn ? { fetchFn: input.fetchFn } : {})
      });
      try {
        const result = await adapter.transcribe({ audio: speechToTextProbeSample(), mimeType: "audio/wav",
          ...(request.signal ? { signal: request.signal } : {}) });
        await recordCheckUsage(binding, request.modelId, result.usage, request.userId);
      } catch (error) {
        if (error instanceof AudioTranscriptionError && error.code === "transcription_response_invalid") {
          // The provider answered and may have charged: the check is accounted.
          await recordCheckUsage(binding, request.modelId, error.usage, request.userId);
        }
        if (request.signal?.aborted) throw error;
        const reason = testFailure(error);
        logEvent("service_operation", { subsystem: "dictation", stage: "probe", outcome: "failed", code: `speech_to_text_test_${reason}`,
          ...(error instanceof AudioTranscriptionError && error.httpStatus ? { httpStatus: error.httpStatus } : {}) });
        throw new SpeechToTextAdminError("speech_to_text_test_failed", reason);
      }
      await guardedWrite(request.expectedConfiguredAt, {
        speechToTextConnectionId: binding.connectionId,
        speechToTextCredentialVersionId: binding.credentialVersionId,
        speechToTextModelId: request.modelId
      }, request.userId);
      logEvent("service_operation", { subsystem: "dictation", stage: "write", outcome: "completed", code: "speech_to_text_role_saved" });
    },

    async clear(request: Readonly<{ expectedConfiguredAt: string | null; userId: string }>): Promise<void> {
      await guardedWrite(request.expectedConfiguredAt, {
        speechToTextConnectionId: null,
        speechToTextCredentialVersionId: null,
        speechToTextModelId: null
      }, request.userId);
    }
  });
}

export type SpeechToTextAdminService = ReturnType<typeof createSpeechToTextAdminService>;
