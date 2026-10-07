import {
  ADMIN_SPEECH_TO_TEXT_MODEL_LIST_LIMIT,
  isSpeechToTextModelId,
  type SpeechToTextProviderFamily
} from "../../contracts/speechToText";
import { readBoundedResponseText, withTimeoutSignal } from "./network";
import {
  normalizeProviderConnectionConfiguration,
  providerAuthenticationMode,
  type ProviderConnectionConfiguration
} from "./providerConfiguration";
import { resolveProviderCredentialSource, type ProviderCredentialSource } from "./providerCredentialSource";
import { createProviderSafeFetch } from "./providerSafeFetch";

const MAX_DISCOVERY_BODY_BYTES = 4 * 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 30_000;
/** Ids of OpenAI-compatible speech-to-text models: `whisper-1`, `whisper-large-v3`, `gpt-4o-transcribe`… */
const COMPATIBLE_TRANSCRIPTION_ID = /whisper|transcribe/iu;

export class TranscriptionModelDiscoveryError extends Error {
  constructor(readonly code: "transcription_discovery_failed" | "transcription_discovery_unauthorized") {
    super(code);
    this.name = "TranscriptionModelDiscoveryError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Candidate model ids from a list response. OpenRouter's Models API is asked
 * for the `transcription` output modality and each row is re-checked locally,
 * so a loose upstream filter never offers a non-STT model; other servers list
 * every model and only ids that name Whisper or transcription are offered.
 * Discovery is availability evidence only: a model is usable after its test.
 */
export function transcriptionModelIds(value: unknown, family: SpeechToTextProviderFamily): string[] {
  if (!record(value) || !Array.isArray(value.data)) throw new TranscriptionModelDiscoveryError("transcription_discovery_failed");
  const ids = new Set<string>();
  for (const entry of value.data) {
    if (!record(entry) || !isSpeechToTextModelId(entry.id)) continue;
    if (family === "openrouter") {
      const architecture = entry.architecture;
      const outputs = record(architecture) && Array.isArray(architecture.output_modalities) ? architecture.output_modalities : [];
      if (!outputs.includes("transcription")) continue;
    } else if (!COMPATIBLE_TRANSCRIPTION_ID.test(entry.id)) continue;
    ids.add(entry.id);
    if (ids.size >= ADMIN_SPEECH_TO_TEXT_MODEL_LIST_LIMIT) break;
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

/** Lists the speech-to-text models one connection offers, with its own key. */
export async function discoverTranscriptionModels(input: Readonly<{
  connection: ProviderConnectionConfiguration;
  family: SpeechToTextProviderFamily;
  fetchFn?: typeof fetch;
  secret: ProviderCredentialSource | null;
  signal?: AbortSignal;
}>): Promise<string[]> {
  const connection = normalizeProviderConnectionConfiguration(input.connection);
  if ((providerAuthenticationMode(connection) === "bearer") !== (input.secret !== null)) {
    throw new TranscriptionModelDiscoveryError("transcription_discovery_failed");
  }
  const fetchFn = input.fetchFn ?? createProviderSafeFetch({ configuration: connection });
  const path = input.family === "openrouter" ? "models?output_modalities=transcription" : "models";
  const timeout = withTimeoutSignal(input.signal, Math.min(connection.responseTimeoutMs, DISCOVERY_TIMEOUT_MS));
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (input.secret !== null) {
      headers.authorization = `Bearer ${await resolveProviderCredentialSource(input.secret, "transcription_discovery_failed")}`;
    }
    const response = await fetchFn(`${connection.apiRoot}/${path}`, { headers, method: "GET", redirect: "error", signal: timeout.signal });
    const text = await readBoundedResponseText(response, { maxBytes: MAX_DISCOVERY_BODY_BYTES, signal: timeout.signal });
    if (response.status === 401 || response.status === 403) throw new TranscriptionModelDiscoveryError("transcription_discovery_unauthorized");
    if (!response.ok) throw new TranscriptionModelDiscoveryError("transcription_discovery_failed");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new TranscriptionModelDiscoveryError("transcription_discovery_failed");
    }
    return transcriptionModelIds(parsed, input.family);
  } catch (error) {
    if (error instanceof TranscriptionModelDiscoveryError || input.signal?.aborted) throw error;
    throw new TranscriptionModelDiscoveryError("transcription_discovery_failed");
  } finally {
    timeout.clear();
  }
}
