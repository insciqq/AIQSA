import { describe, expect, it, vi } from "vitest";
import { createReadAloudController, type ReadAloudSynth } from "./readAloudController";

type FakeUtterance = {
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  text: string;
  voice: SpeechSynthesisVoice | null;
};

function fakeSynth(initialVoices: Partial<SpeechSynthesisVoice>[] = []) {
  let voices = initialVoices as SpeechSynthesisVoice[];
  const voicesChanged: Array<() => void> = [];
  const queue: FakeUtterance[] = [];
  const spoken: FakeUtterance[] = [];
  const synth = {
    addEventListener: (_type: "voiceschanged", listener: () => void) => voicesChanged.push(listener),
    cancel: vi.fn(() => {
      // Browsers still deliver an event to each cancelled utterance.
      for (const utterance of queue.splice(0)) utterance.onerror?.();
    }),
    getVoices: () => voices,
    paused: false,
    resume: vi.fn(),
    speak: vi.fn((utterance: SpeechSynthesisUtterance) => {
      queue.push(utterance as unknown as FakeUtterance);
      spoken.push(utterance as unknown as FakeUtterance);
    })
  } satisfies ReadAloudSynth;
  return {
    finishAll() {
      for (const utterance of queue.splice(0)) utterance.onend?.();
    },
    loadVoices(next: Partial<SpeechSynthesisVoice>[]) {
      voices = next as SpeechSynthesisVoice[];
      for (const listener of voicesChanged) listener();
    },
    queue,
    spoken,
    synth
  };
}

function controllerFor(fake: ReturnType<typeof fakeSynth>, fallback = "en-US") {
  return createReadAloudController({
    createUtterance: (text) => ({ lang: "", onend: null, onerror: null, text, voice: null }) as unknown as SpeechSynthesisUtterance,
    fallbackLanguage: () => fallback,
    synth: fake.synth
  });
}

describe("createReadAloudController", () => {
  it("queues bounded utterances in order and settles after the last one ends", () => {
    const fake = fakeSynth();
    const controller = controllerFor(fake);
    const listener = vi.fn();
    controller.subscribe(listener);
    const long = "Sentence number one is here. ".repeat(20);

    controller.start("a1", `${long}\n\n\`\`\`js\nconsole.log(1)\n\`\`\`\n\nThe end.`);

    expect(controller.activeId()).toBe("a1");
    expect(fake.queue.length).toBeGreaterThan(2);
    expect(fake.queue.every((utterance) => utterance.text.length <= 220 && utterance.lang === "en-US")).toBe(true);
    expect(fake.queue.map((utterance) => utterance.text).join(" ")).toMatch(/Code block skipped\. The end\.$/u);
    expect(listener).toHaveBeenCalledTimes(1);

    fake.finishAll();
    expect(controller.activeId()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("starting another answer cancels the first without its stale events ending the second", () => {
    const fake = fakeSynth();
    const controller = controllerFor(fake);
    controller.start("a1", "First answer.");
    controller.start("a2", "Second answer.");

    expect(fake.synth.cancel).toHaveBeenCalled();
    expect(controller.activeId()).toBe("a2");
    expect(fake.queue.map((utterance) => utterance.text)).toEqual(["Second answer."]);
    // A late end of the cancelled first utterance is ignored.
    fake.spoken[0]!.onend?.();
    expect(controller.activeId()).toBe("a2");
  });

  it("toggle stops the speaking answer, and idle stops leave other speech alone", () => {
    const fake = fakeSynth();
    const controller = controllerFor(fake);
    controller.stop();
    expect(fake.synth.cancel).not.toHaveBeenCalled();

    controller.toggle("a1", "Hello there.");
    expect(controller.activeId()).toBe("a1");
    controller.toggle("a1", "Hello there.");
    expect(controller.activeId()).toBeNull();
    expect(fake.queue).toEqual([]);
  });

  it("an utterance error ends the whole answer", () => {
    const fake = fakeSynth();
    const controller = controllerFor(fake);
    controller.start("a1", `${"Alpha beta gamma. ".repeat(30)}`);
    fake.queue[0]!.onerror?.();
    expect(controller.activeId()).toBeNull();
    expect(fake.synth.cancel).toHaveBeenCalled();
  });

  it("reads a Russian answer with a Russian voice once voices load", () => {
    const fake = fakeSynth();
    const controller = controllerFor(fake);
    controller.start("a1", "Привет, это ответ.");
    // Before voices arrive the language alone selects the browser's voice.
    expect(fake.queue[0]).toMatchObject({ lang: "ru-RU", voice: null });

    fake.loadVoices([
      { default: true, lang: "en-US", localService: true, name: "English" },
      { default: false, lang: "ru-RU", localService: true, name: "Milena" }
    ]);
    controller.start("a1", "Привет, это ответ.");
    expect(fake.queue[0]?.lang).toBe("ru-RU");
    expect(fake.queue[0]?.voice?.name).toBe("Milena");
  });

  it("does not become active for an answer with nothing to read", () => {
    const fake = fakeSynth();
    const controller = controllerFor(fake);
    controller.start("a1", "[K1]");
    expect(controller.activeId()).toBeNull();
    expect(fake.synth.speak).not.toHaveBeenCalled();
  });

  it("resumes a paused synthesizer before speaking", () => {
    const fake = fakeSynth();
    const controller = createReadAloudController({
      createUtterance: (text) => ({ text }) as unknown as SpeechSynthesisUtterance,
      fallbackLanguage: () => "en",
      synth: { ...fake.synth, paused: true }
    });
    controller.start("a1", "Hello.");
    expect(fake.synth.resume).toHaveBeenCalled();
  });
});
