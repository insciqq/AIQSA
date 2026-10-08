import {
  decodeAdminSpeechToTextModels,
  decodeAdminSpeechToTextResponse,
  SPEECH_TO_TEXT_TEST_FAILURES,
  type AdminSpeechToTextRole,
  type SpeechToTextTestFailure
} from "@/lib/contracts/speechToText";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminSpeechToTextFailure = Readonly<{ error: string; ok: false; reason: SpeechToTextTestFailure | null }>;
export type AdminSpeechToTextResult<T> = Readonly<{ data: T; ok: true }> | AdminSpeechToTextFailure;

const ENDPOINT = "/api/admin/providers/speech-to-text";

async function call<T>(init: RequestInit, decode: (value: unknown) => T | null, fetcher: Fetcher): Promise<AdminSpeechToTextResult<T>> {
  try {
    const response = await fetcher(ENDPOINT, { credentials: "same-origin", ...init });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const body = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
      return {
        error: typeof body.error === "string" ? body.error : "speech_to_text_admin_action_failed",
        ok: false,
        reason: (SPEECH_TO_TEXT_TEST_FAILURES as readonly unknown[]).includes(body.reason) ? body.reason as SpeechToTextTestFailure : null
      };
    }
    const data = decode(value);
    return data === null ? { error: "speech_to_text_response_invalid", ok: false, reason: null } : { data, ok: true };
  } catch {
    return { error: "network_error", ok: false, reason: null };
  }
}

function post<T>(body: Record<string, unknown>, decode: (value: unknown) => T | null, fetcher: Fetcher) {
  return call({ body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" }, decode, fetcher);
}

export function getAdminSpeechToText(fetcher: Fetcher = fetch) {
  return call<AdminSpeechToTextRole>({ method: "GET" }, decodeAdminSpeechToTextResponse, fetcher);
}

export function discoverAdminSpeechToTextModels(connectionId: string, fetcher: Fetcher = fetch) {
  return post({ action: "discover", connectionId }, decodeAdminSpeechToTextModels, fetcher);
}

export function testAndSaveAdminSpeechToText(input: Readonly<{ connectionId: string; expectedConfiguredAt: string | null; modelId: string }>,
  fetcher: Fetcher = fetch) {
  return post({ action: "test_and_save", ...input }, decodeAdminSpeechToTextResponse, fetcher);
}

export function clearAdminSpeechToText(expectedConfiguredAt: string | null, fetcher: Fetcher = fetch) {
  return post({ action: "clear", expectedConfiguredAt }, decodeAdminSpeechToTextResponse, fetcher);
}

const TEST_FAILURE_MESSAGES: Record<SpeechToTextTestFailure, string> = {
  unauthorized: "The provider refused this provider's default key. Check the key in Providers, then test again.",
  rejected: "The provider rejected the test recording for this model. Choose a speech-to-text model and test again.",
  unreachable: "The provider could not be reached or is busy. Try again in a moment.",
  timed_out: "The provider did not answer in time. Try again in a moment.",
  invalid_response: "The provider's answer was not a transcription. Choose a speech-to-text model and test again."
};

export function adminSpeechToTextErrorMessage(failure: AdminSpeechToTextFailure): string {
  if (failure.error === "speech_to_text_test_failed") {
    return `Test failed, nothing was saved. ${failure.reason ? TEST_FAILURE_MESSAGES[failure.reason] : TEST_FAILURE_MESSAGES.unreachable}`;
  }
  const messages: Record<string, string> = {
    network_error: "Speech to text settings could not be reached.",
    speech_to_text_admin_action_failed: "Speech to text could not be updated.",
    speech_to_text_connection_unavailable: "This provider is turned off or has no usable default key. Fix it in Providers first.",
    speech_to_text_discovery_failed: "The provider's model list could not be read. Enter the model id instead.",
    speech_to_text_discovery_unauthorized: "The provider refused this provider's default key. Check the key in Providers.",
    speech_to_text_model_invalid: "Enter a valid model id.",
    speech_to_text_response_invalid: "The Speech to text response was invalid.",
    speech_to_text_stale: "Speech to text changed elsewhere. Reload and try again."
  };
  return messages[failure.error] ?? failure.error.replaceAll("_", " ");
}
