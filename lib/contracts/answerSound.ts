export const ANSWER_SOUNDS = [
  { label: "Rise", value: "rise" },
  { label: "Bell", value: "bell" },
  { label: "Drop", value: "drop" },
  { label: "Double tap", value: "double-tap" },
  { label: "Soft bell", value: "soft-bell" },
  { label: "Warm success", value: "warm-success" },
  { label: "Marimba", value: "marimba" },
  { label: "Gentle pop", value: "gentle-pop" },
  { label: "Minimal confirm", value: "minimal-confirm" },
  { label: "Liquid bubble", value: "liquid-bubble" }
] as const;

export type AnswerSoundId = typeof ANSWER_SOUNDS[number]["value"];

export type AnswerSoundPreferences = {
  answerSoundEnabled: boolean;
  answerSoundId: AnswerSoundId;
};

export const DEFAULT_ANSWER_SOUND: AnswerSoundPreferences = {
  answerSoundEnabled: true,
  answerSoundId: "rise"
};

export function isAnswerSoundId(value: unknown): value is AnswerSoundId {
  return ANSWER_SOUNDS.some((sound) => sound.value === value);
}

export function decodeAnswerSoundPreferences(value: {
  answerSoundEnabled?: unknown;
  answerSoundId?: unknown;
}): AnswerSoundPreferences | null {
  if ((value.answerSoundEnabled !== undefined && typeof value.answerSoundEnabled !== "boolean") ||
    (value.answerSoundId !== undefined && !isAnswerSoundId(value.answerSoundId))) return null;
  return {
    answerSoundEnabled: value.answerSoundEnabled ?? DEFAULT_ANSWER_SOUND.answerSoundEnabled,
    answerSoundId: value.answerSoundId ?? DEFAULT_ANSWER_SOUND.answerSoundId
  };
}
