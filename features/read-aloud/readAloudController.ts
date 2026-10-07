import {
  answerSpeech,
  chunkSpeech,
  pickVoice,
  resolveFallbackLanguage
} from "./speechText";

/** The parts of `SpeechSynthesis` the controller uses; tests pass a fake. */
export type ReadAloudSynth = Readonly<{
  addEventListener?(type: "voiceschanged", listener: () => void): void;
  cancel(): void;
  getVoices(): SpeechSynthesisVoice[];
  paused?: boolean;
  resume?(): void;
  speak(utterance: SpeechSynthesisUtterance): void;
}>;

export type ReadAloudController = Readonly<{
  activeId(): string | null;
  /** Speaks `markdown` as answer `id`, replacing whatever was speaking. */
  start(id: string, markdown: string): void;
  stop(): void;
  subscribe(listener: () => void): () => void;
  /** Starts `id`, or stops it when it is the one speaking. */
  toggle(id: string, markdown: string): void;
}>;

export type ReadAloudControllerOptions = Readonly<{
  createUtterance(text: string): SpeechSynthesisUtterance;
  fallbackLanguage(): string;
  synth: ReadAloudSynth;
}>;

/**
 * One answer speaks at a time. Every utterance of an answer is queued at once
 * inside the user's gesture (iOS refuses speech started later), each keeping
 * a reference so its events survive garbage collection. A generation number
 * ignores the `end`/`error` events that cancelled utterances still deliver.
 */
export function createReadAloudController({
  createUtterance,
  fallbackLanguage,
  synth
}: ReadAloudControllerOptions): ReadAloudController {
  const listeners = new Set<() => void>();
  let active: string | null = null;
  let generation = 0;
  let queued: SpeechSynthesisUtterance[] = [];
  // Voices often arrive asynchronously; the first answer read before they do
  // still gets the right language through `utterance.lang`.
  let voices = synth.getVoices();
  synth.addEventListener?.("voiceschanged", () => {
    voices = synth.getVoices();
  });

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const settle = (owner: number) => {
    if (owner !== generation || active === null) return;
    active = null;
    queued = [];
    notify();
  };

  // Idle stops (chat switch, unmount) leave speech the app does not own alone.
  const stop = () => {
    if (active === null) return;
    generation += 1;
    queued = [];
    active = null;
    synth.cancel();
    notify();
  };

  const start = (id: string, markdown: string) => {
    generation += 1;
    const owner = generation;
    const previous = active;
    queued = [];
    synth.cancel();
    const { lang, sentences } = answerSpeech(markdown, fallbackLanguage());
    const chunks = chunkSpeech(sentences);
    if (!chunks.length) {
      active = null;
      if (previous !== null) notify();
      return;
    }
    const voice = pickVoice(voices, lang);
    active = id;
    if (synth.paused) synth.resume?.();
    queued = chunks.map((text, index) => {
      const utterance = createUtterance(text);
      utterance.lang = lang;
      if (voice) utterance.voice = voice;
      if (index === chunks.length - 1) utterance.onend = () => settle(owner);
      // An error ends the whole answer: speaking past a lost sentence misleads.
      utterance.onerror = () => {
        if (owner !== generation) return;
        stop();
      };
      return utterance;
    });
    notify();
    for (const utterance of queued) synth.speak(utterance);
  };

  return {
    activeId: () => active,
    start,
    stop,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toggle(id, markdown) {
      if (active === id) stop();
      else start(id, markdown);
    }
  };
}

let shared: ReadAloudController | null | undefined;

/** Browser speech is available: the synthesis service and its utterance type. */
export function readAloudSupported(): boolean {
  return typeof window !== "undefined" &&
    typeof window.speechSynthesis === "object" && window.speechSynthesis !== null &&
    typeof window.SpeechSynthesisUtterance === "function";
}

/**
 * The page-wide controller, or `null` without browser speech. Leaving the page
 * (navigation, reload, bfcache) cancels speech: Chrome otherwise keeps
 * speaking the old page's queue.
 */
export function sharedReadAloudController(): ReadAloudController | null {
  if (shared !== undefined) return shared;
  if (!readAloudSupported()) return null;
  const synth = window.speechSynthesis;
  const controller = createReadAloudController({
    createUtterance: (text) => new window.SpeechSynthesisUtterance(text),
    fallbackLanguage: () => resolveFallbackLanguage(
      document.documentElement.lang,
      navigator.languages?.length ? navigator.languages : [navigator.language]
    ),
    synth
  });
  window.addEventListener("pagehide", () => controller.stop());
  shared = controller;
  return controller;
}

/** Test-only: forget the page-wide controller. */
export function resetSharedReadAloudControllerForTests(): void {
  shared = undefined;
}
