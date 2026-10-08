"use client";

import { shellFetch } from "@/components/app-shell/shellApi";
import { usageLimitRefusalMessage } from "@/components/app-shell/shellFormatting";
import {
  DICTATION_AUDIO_MAX_BYTES,
  DICTATION_MAX_DURATION_MS,
  DICTATION_RECORDER_MIME_TYPES,
  decodeTranscriptionResponse,
  dictationAudioExtension,
  dictationAudioMimeType,
  isTranscriptionErrorCode,
  type TranscriptionErrorCode
} from "@/lib/contracts/speechToText";
import { decodeUsageLimitRefusal } from "@/lib/contracts/usageLimits";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export type DictationPhase = "idle" | "starting" | "recording" | "transcribing";

/** Why this browser cannot record here, or null when it can. */
export function dictationSupportReason(): string | null {
  if (typeof window === "undefined") return null;
  if (!window.isSecureContext) return "Dictation needs a secure connection (HTTPS). Open AIQSA over HTTPS to use the microphone.";
  if (typeof MediaRecorder === "undefined" || typeof navigator.mediaDevices?.getUserMedia !== "function") {
    return "This browser cannot record audio. Use a current browser to dictate.";
  }
  return null;
}

const noSubscription = () => () => undefined;

/** Browser capability, read after hydration so the server render never guesses it. */
export function useDictationSupportReason(): string | null | "pending" {
  return useSyncExternalStore(noSubscription, dictationSupportReason, () => "pending");
}

function recorderMimeType(): string {
  return DICTATION_RECORDER_MIME_TYPES.find((type) => {
    try {
      return MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  }) ?? "";
}

function microphoneError(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. Connect one and try again.";
  if (name === "NotReadableError" || name === "AbortError") return "The microphone is in use by another app. Close it and try again.";
  return "The microphone could not be started. Try again.";
}

const TRANSCRIPTION_MESSAGES: Record<TranscriptionErrorCode, string> = {
  unauthorized: "Your session has ended. Sign in again to dictate; your draft is kept.",
  multipart_required: "The recording could not be sent. Try again.",
  audio_required: "Nothing was recorded. Check your microphone and try again.",
  audio_too_large: "The recording is too long to transcribe. Keep dictations under 5 minutes.",
  audio_type_unsupported: "This browser's recording format is not supported. Try another browser.",
  dictation_unavailable: "Dictation is unavailable right now. Ask your administrator to check Speech to text.",
  dictation_rate_limited: "You've dictated a lot in the last few minutes. Wait a little and try again.",
  usage_limits_unavailable: "Your usage could not be checked, so the recording was not sent. Try again.",
  transcription_rejected: "The speech service could not read this recording. Try again.",
  transcription_busy: "The speech service is busy. Try again in a moment.",
  transcription_timed_out: "Transcription took too long. Try a shorter recording.",
  transcription_failed: "The recording could not be transcribed. Try again."
};

async function transcriptionFailure(response: Response): Promise<string> {
  const value: unknown = await response.json().catch(() => null);
  const refusal = decodeUsageLimitRefusal(value);
  if (refusal) return `Recording discarded. ${usageLimitRefusalMessage(refusal)}`;
  const code = typeof value === "object" && value !== null ? (value as Record<string, unknown>).error : null;
  if (response.status === 401) return TRANSCRIPTION_MESSAGES.unauthorized;
  return isTranscriptionErrorCode(code) ? TRANSCRIPTION_MESSAGES[code] : TRANSCRIPTION_MESSAGES.transcription_failed;
}

type Session = {
  cancelled: boolean;
  chunks: Blob[];
  controller: AbortController | null;
  recorder: MediaRecorder | null;
  stream: MediaStream | null;
  timer: ReturnType<typeof setInterval> | null;
  autoStop: ReturnType<typeof setTimeout> | null;
};

/**
 * One dictation at a time: microphone permission, recording with an elapsed
 * timer and a 5-minute auto-stop, upload to `/api/me/transcriptions`, then
 * `onText` with the transcript. Cancel discards the audio at any phase. The
 * audio only lives in this browser until it is sent; nothing is kept after.
 */
export function useDictationRecorder(input: Readonly<{
  onError(message: string): void;
  onText(text: string): void;
}>) {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const session = useRef<Session | null>(null);
  const callbacks = useRef(input);
  useEffect(() => { callbacks.current = input; });

  const release = useCallback((current: Session) => {
    if (current.timer) clearInterval(current.timer);
    if (current.autoStop) clearTimeout(current.autoStop);
    current.timer = null;
    current.autoStop = null;
    current.stream?.getTracks().forEach((track) => track.stop());
    current.stream = null;
  }, []);

  const finish = useCallback((current: Session) => {
    release(current);
    if (session.current === current) session.current = null;
    setPhase("idle");
    setElapsedMs(0);
  }, [release]);

  const upload = useCallback(async (current: Session, blob: Blob) => {
    const type = dictationAudioMimeType(blob.type);
    if (!blob.size) {
      finish(current);
      callbacks.current.onError(TRANSCRIPTION_MESSAGES.audio_required);
      return;
    }
    if (!type) {
      finish(current);
      callbacks.current.onError(TRANSCRIPTION_MESSAGES.audio_type_unsupported);
      return;
    }
    if (blob.size > DICTATION_AUDIO_MAX_BYTES) {
      finish(current);
      callbacks.current.onError(TRANSCRIPTION_MESSAGES.audio_too_large);
      return;
    }
    const controller = new AbortController();
    current.controller = controller;
    setPhase("transcribing");
    const form = new FormData();
    form.append("file", blob, `dictation.${dictationAudioExtension(type)}`);
    try {
      const response = await shellFetch("/api/me/transcriptions", { body: form, credentials: "same-origin", method: "POST",
        signal: controller.signal });
      if (current.cancelled) return;
      if (!response.ok) {
        const message = await transcriptionFailure(response);
        if (current.cancelled) return;
        finish(current);
        callbacks.current.onError(message);
        return;
      }
      const decoded = decodeTranscriptionResponse(await response.json().catch(() => null));
      if (current.cancelled) return;
      finish(current);
      if (!decoded) callbacks.current.onError(TRANSCRIPTION_MESSAGES.transcription_failed);
      else if (!decoded.text.trim()) callbacks.current.onError("No speech was recognized. Try again closer to the microphone.");
      else callbacks.current.onText(decoded.text.trim());
    } catch {
      if (current.cancelled) return;
      finish(current);
      callbacks.current.onError("The recording could not be sent. Check your connection and try again.");
    }
  }, [finish]);

  const stop = useCallback(() => {
    const current = session.current;
    if (!current?.recorder || current.recorder.state === "inactive") return;
    current.recorder.stop();
  }, []);

  const cancel = useCallback(() => {
    const current = session.current;
    if (!current) return;
    current.cancelled = true;
    current.controller?.abort();
    if (current.recorder && current.recorder.state !== "inactive") {
      try { current.recorder.stop(); } catch { /* already stopped */ }
    }
    current.chunks = [];
    finish(current);
  }, [finish]);

  const start = useCallback(async () => {
    if (session.current) return;
    const current: Session = { autoStop: null, cancelled: false, chunks: [], controller: null, recorder: null, stream: null, timer: null };
    session.current = current;
    setPhase("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (current.cancelled) return;
      finish(current);
      callbacks.current.onError(microphoneError(error));
      return;
    }
    current.stream = stream;
    if (current.cancelled) {
      release(current);
      return;
    }
    let recorder: MediaRecorder;
    const mimeType = recorderMimeType();
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (error) {
      finish(current);
      callbacks.current.onError(microphoneError(error));
      return;
    }
    current.recorder = recorder;
    recorder.addEventListener("dataavailable", (event: BlobEvent) => {
      if (!current.cancelled && event.data.size) current.chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      release(current);
      if (current.cancelled) return;
      void upload(current, new Blob(current.chunks, { type: recorder.mimeType || mimeType }));
      current.chunks = [];
    });
    const startedAt = Date.now();
    recorder.start(1_000);
    setElapsedMs(0);
    setPhase("recording");
    current.timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
    current.autoStop = setTimeout(stop, DICTATION_MAX_DURATION_MS);
  }, [finish, release, stop, upload]);

  // Leaving the composer (unmount) discards an unfinished dictation and frees the microphone.
  useEffect(() => () => {
    const current = session.current;
    if (!current) return;
    current.cancelled = true;
    current.controller?.abort();
    if (current.recorder && current.recorder.state !== "inactive") {
      try { current.recorder.stop(); } catch { /* already stopped */ }
    }
    if (current.timer) clearInterval(current.timer);
    if (current.autoStop) clearTimeout(current.autoStop);
    current.stream?.getTracks().forEach((track) => track.stop());
    session.current = null;
  }, []);

  return { cancel, elapsedMs, phase, start, stop };
}
