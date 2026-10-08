/**
 * The administrator Test's audio: a tiny synthetic voice-like WAV generated in
 * code (a glottal pulse train through three vowel formants), never a person's
 * recording. The test proves that the endpoint, key and model accept audio and
 * answer with a transcription; it does not grade the words.
 */
const SAMPLE_RATE = 16_000;
const DURATION_SECONDS = 1.2;
const PITCH_HZ = 120;
/** Formant pairs of the vowels "a", "i" and "u". */
const VOWELS: readonly (readonly [number, number])[] = [[730, 1090], [270, 2290], [300, 870]];

function voiceSample(index: number): number {
  const time = index / SAMPLE_RATE;
  const vowel = VOWELS[Math.min(VOWELS.length - 1, Math.floor((time / DURATION_SECONDS) * VOWELS.length))]!;
  let value = 0;
  // Harmonics of the pitch, weighted by their distance to each formant.
  for (let harmonic = 1; harmonic * PITCH_HZ < 4_000; harmonic += 1) {
    const frequency = harmonic * PITCH_HZ;
    const weight = vowel.reduce((sum, formant) => sum + 1 / (1 + ((frequency - formant) / 90) ** 2), 0) / harmonic;
    value += weight * Math.sin(2 * Math.PI * frequency * time);
  }
  // Fade in and out so the sample has no clicks.
  const envelope = Math.min(1, time / 0.05, (DURATION_SECONDS - time) / 0.05);
  return value * Math.max(0, envelope);
}

let cached: Uint8Array | null = null;

/** 16 kHz mono 16-bit PCM WAV, about 38 KB; deterministic. */
export function speechToTextProbeSample(): Uint8Array {
  if (cached) return cached;
  const count = Math.round(SAMPLE_RATE * DURATION_SECONDS);
  const samples = Array.from({ length: count }, (_, index) => voiceSample(index));
  const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0) || 1;
  const buffer = Buffer.alloc(44 + count * 2);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + count * 2, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(count * 2, 40);
  samples.forEach((value, index) => buffer.writeInt16LE(Math.round((value / peak) * 0.6 * 32_767), 44 + index * 2));
  cached = new Uint8Array(buffer);
  return cached;
}
