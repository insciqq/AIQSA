import type { AnswerSoundId } from "@/lib/contracts/answerSound";

type Note = {
  delay?: number;
  duration: number;
  frequency: number;
  endFrequency?: number;
  peak: number;
  tail?: number;
};

const SOURCES: Record<AnswerSoundId, readonly Note[] | string> = {
  rise: [{ duration: 0.36, frequency: 880, endFrequency: 1320, peak: 0.14, tail: 0.04 }],
  bell: [
    { duration: 0.42, frequency: 1046.5, peak: 0.075 },
    { delay: 0.11, duration: 0.34, frequency: 1568, peak: 0.035 }
  ],
  drop: [{ duration: 0.3, frequency: 660, endFrequency: 440, peak: 0.1 }],
  "double-tap": [
    { duration: 0.1, frequency: 740, peak: 0.08 },
    { delay: 0.16, duration: 0.1, frequency: 740, peak: 0.08 }
  ],
  "soft-bell": "/sounds/answer/soft-bell.wav",
  "warm-success": "/sounds/answer/warm-success.wav",
  marimba: "/sounds/answer/marimba.wav",
  "gentle-pop": "/sounds/answer/gentle-pop.wav",
  "minimal-confirm": "/sounds/answer/minimal-confirm.wav",
  "liquid-bubble": "/sounds/answer/liquid-bubble.wav"
};

const samples = new WeakMap<AudioContext, Map<AnswerSoundId, AudioBuffer>>();

export async function prepareAnswerSound(context: AudioContext, sound: AnswerSoundId, signal: AbortSignal): Promise<AudioBuffer | null> {
  const source = SOURCES[sound];
  if (typeof source !== "string") return null;
  const cached = samples.get(context)?.get(sound);
  if (cached) return cached;
  const response = await fetch(source, { signal });
  if (!response.ok) throw new Error("Answer sound unavailable");
  const buffer = await context.decodeAudioData(await response.arrayBuffer());
  if (signal.aborted) return null;
  const cache = samples.get(context) ?? new Map<AnswerSoundId, AudioBuffer>();
  cache.set(sound, buffer);
  samples.set(context, cache);
  return buffer;
}

/** Own every scheduled node, including future notes, until it ends or is replaced. */
export function startAnswerSound(context: AudioContext, sound: AnswerSoundId, onEnded: () => void, buffer: AudioBuffer | null = null): () => void {
  const source = SOURCES[sound];
  if (typeof source === "string") {
    if (!buffer) throw new Error("Answer sound not prepared");
    const node = context.createBufferSource();
    const cancel = () => {
      node.onended = null;
      try { node.stop(); } catch { /* A node which failed to start only needs disconnecting. */ }
      node.disconnect();
    };
    try {
      node.buffer = buffer;
      node.connect(context.destination);
      node.onended = () => { node.disconnect(); onEnded(); };
      node.start();
    } catch (error) {
      cancel();
      throw error;
    }
    return cancel;
  }
  const voices = new Set<{ oscillator: OscillatorNode; gain: GainNode }>();
  function cancel() {
    for (const voice of voices) {
      voice.oscillator.onended = null;
      try { voice.oscillator.stop(); } catch { /* An ended node needs only disconnecting. */ }
      voice.oscillator.disconnect();
      voice.gain.disconnect();
    }
    voices.clear();
  }
  try {
    for (const note of source) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const voice = { oscillator, gain };
      voices.add(voice);
      const start = context.currentTime + (note.delay ?? 0);
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(note.frequency, start);
      if (note.endFrequency) oscillator.frequency.exponentialRampToValueAtTime(note.endFrequency, start + 0.16);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(note.peak, start + 0.03);
      if (note.tail) gain.gain.exponentialRampToValueAtTime(note.tail, start + 0.2);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.duration - 0.02);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
        voices.delete(voice);
        if (voices.size === 0) onEnded();
      };
      oscillator.start(start);
      oscillator.stop(start + note.duration);
    }
  } catch (error) {
    cancel();
    throw error;
  }
  return cancel;
}
