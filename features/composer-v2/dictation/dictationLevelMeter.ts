"use client";

/** Below this RMS level (dBFS) a slice reads as silence; at the ceiling it is full scale. */
const LEVEL_FLOOR_DB = -60;
const LEVEL_CEILING_DB = -12;

/**
 * The loudness of one block of time-domain samples (-1..1) on a perceptual,
 * dB-like 0..1 scale: RMS in dBFS mapped linearly from the floor (0, silence)
 * to the ceiling (1). Anything not finite counts as silence.
 */
export function dictationLevel(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]!;
    if (Number.isFinite(value)) sum += value * value;
  }
  const rms = Math.sqrt(sum / samples.length);
  if (!(rms > 0)) return 0;
  const level = (20 * Math.log10(rms) - LEVEL_FLOOR_DB) / (LEVEL_CEILING_DB - LEVEL_FLOOR_DB);
  return Math.min(1, Math.max(0, level));
}

export type DictationLevelMeter = Readonly<{
  /** The current measured level, 0..1; 0 once closed. */
  level(): number;
  /** Disconnects the analyser and closes the audio context. Idempotent. */
  close(): void;
}>;

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  const scope = globalThis as unknown as { AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * Reads the microphone level of `stream` through an analyser: source to
 * analyser only, never to the speakers, and nothing is kept or sent.
 * `onLiveChange` reports whether the level can really be measured (the
 * context is `running`), now and whenever the context changes state, until
 * the meter is closed. Returns null when this browser cannot build one.
 */
export function createDictationLevelMeter(stream: MediaStream, onLiveChange: (live: boolean) => void): DictationLevelMeter | null {
  const Context = audioContextConstructor();
  if (!Context) return null;
  let context: AudioContext;
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    context = new Context();
  } catch {
    return null;
  }
  try {
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
  } catch {
    void context.close().catch(() => undefined);
    return null;
  }
  const floats = new Float32Array(analyser.fftSize);
  const bytes = typeof analyser.getFloatTimeDomainData === "function" ? null : new Uint8Array(analyser.fftSize);
  let closed = false;
  const report = () => {
    if (!closed) onLiveChange(context.state === "running");
  };
  context.addEventListener("statechange", report);
  void Promise.resolve()
    .then(() => context.state === "running" ? undefined : context.resume())
    .catch(() => undefined)
    .then(report);

  return {
    level() {
      if (closed || context.state !== "running") return 0;
      if (bytes) {
        analyser.getByteTimeDomainData(bytes);
        for (let index = 0; index < bytes.length; index += 1) floats[index] = (bytes[index]! - 128) / 128;
      } else {
        analyser.getFloatTimeDomainData(floats);
      }
      return dictationLevel(floats);
    },
    close() {
      if (closed) return;
      closed = true;
      context.removeEventListener("statechange", report);
      try { source.disconnect(); } catch { /* already disconnected */ }
      try { analyser.disconnect(); } catch { /* already disconnected */ }
      if (context.state !== "closed") void context.close().catch(() => undefined);
    }
  };
}
