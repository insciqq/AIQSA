import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANSWER_SOUNDS, type AnswerSoundPreferences } from "@/lib/contracts/answerSound";
import { useAnswerNotification } from "./useAnswerNotification";

function audioHarness() {
  const buffers: Array<{
    buffer: AudioBuffer | null; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>;
    onended: (() => void) | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>;
  }> = [];
  const voices: Array<{
    connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>;
    frequency: { exponentialRampToValueAtTime: ReturnType<typeof vi.fn>; setValueAtTime: ReturnType<typeof vi.fn> };
    onended: (() => void) | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; type: string;
  }> = [];
  const gains: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; gain: {
    exponentialRampToValueAtTime: ReturnType<typeof vi.fn>; setValueAtTime: ReturnType<typeof vi.fn>;
  } }> = [];
  const context = {
    close: vi.fn(async () => undefined),
    createBufferSource: vi.fn(() => {
      const node = { buffer: null as AudioBuffer | null, connect: vi.fn(), disconnect: vi.fn(),
        onended: null as (() => void) | null, start: vi.fn(), stop: vi.fn() };
      buffers.push(node);
      return node;
    }),
    decodeAudioData: vi.fn(async (data: ArrayBuffer) => ({ source: new TextDecoder().decode(data) }) as unknown as AudioBuffer),
    createGain: vi.fn(() => {
      const gain = { connect: vi.fn(), disconnect: vi.fn(), gain: { exponentialRampToValueAtTime: vi.fn(), setValueAtTime: vi.fn() } };
      gains.push(gain);
      return gain;
    }),
    createOscillator: vi.fn(() => {
      const voice = { connect: vi.fn(), disconnect: vi.fn(), frequency: {
        exponentialRampToValueAtTime: vi.fn(), setValueAtTime: vi.fn()
      }, onended: null as (() => void) | null, start: vi.fn(), stop: vi.fn(), type: "sine" };
      voices.push(voice);
      return voice;
    }),
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => { context.state = "running"; }),
    state: "running"
  };
  const Constructor = vi.fn(function AudioContextMock() { return context; });
  vi.stubGlobal("AudioContext", Constructor);
  const fetchSample = vi.fn(async (url: string, _init?: RequestInit) => new Response(url));
  vi.stubGlobal("fetch", fetchSample);
  return { Constructor, context, gains, voices, buffers, fetchSample };
}

function mount(preferences: AnswerSoundPreferences | null = { answerSoundEnabled: true, answerSoundId: "rise" }) {
  const state = { preferences };
  const hook = renderHook(({ accountId }) => useAnswerNotification({ accountId, readPreferences: () => state.preferences }), {
    initialProps: { accountId: "account-a" }
  });
  return { ...hook, state };
}

function faviconPath() {
  const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  return link ? new URL(link.href).pathname : null;
}

afterEach(() => {
  document.head.querySelectorAll('link[rel~="icon"]').forEach((link) => link.remove());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("answer completion audio", () => {
  it("waits for account settings, ignores legacy storage, and independently pulses the favicon when muted", async () => {
    const { Constructor } = audioHarness();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    const { result, state } = mount(null);
    await result.current.primeAnswerSound();
    await result.current.notifyAnswerReady();
    expect(Constructor).not.toHaveBeenCalled();
    expect(faviconPath()).toBe("/favicon-alert.svg");
    state.preferences = { answerSoundEnabled: false, answerSoundId: "bell" };
    await result.current.notifyAnswerReady();
    expect(Constructor).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("focus"));
    expect(faviconPath()).toBe("/favicon.svg");
  });

  it("reads the latest mute and choice from a callback captured when generation starts", async () => {
    const { voices } = audioHarness();
    const { result, state } = mount();
    const captured = result.current.notifyAnswerReady;
    state.preferences = { answerSoundEnabled: false, answerSoundId: "drop" };
    await captured();
    expect(voices).toHaveLength(0);
    state.preferences.answerSoundEnabled = true;
    await captured();
    expect(voices[0]?.frequency.setValueAtTime).toHaveBeenCalledWith(660, 0);
  });

  it.each(["mute", "account", "unmount"])("cancels delayed audio after a suspended resume: %s", async (change) => {
    const { context, voices } = audioHarness();
    context.state = "suspended";
    let resume!: () => void;
    context.resume.mockImplementation(() => new Promise<void>((resolve) => { resume = resolve; }));
    const { result, state, rerender, unmount } = mount();
    const captured = result.current.notifyAnswerReady;
    const pending = captured();
    if (change === "mute") state.preferences = { answerSoundEnabled: false, answerSoundId: "rise" };
    if (change === "account") rerender({ accountId: "account-b" });
    if (change === "unmount") unmount();
    context.state = "running";
    await act(async () => { resume(); await pending; });
    expect(voices).toHaveLength(0);
    if (change === "account") {
      await captured();
      expect(voices).toHaveLength(0);
      expect(faviconPath()).toBe("/favicon.svg");
    }
  });

  it("rechecks the selected sound after resume", async () => {
    const { context, voices } = audioHarness();
    context.state = "suspended";
    let resume!: () => void;
    context.resume.mockImplementation(() => new Promise<void>((resolve) => { resume = resolve; }));
    const { result, state } = mount();
    const pending = result.current.notifyAnswerReady();
    state.preferences = { answerSoundEnabled: true, answerSoundId: "double-tap" };
    context.state = "running";
    await act(async () => { resume(); await pending; });
    expect(voices).toHaveLength(2);
    expect(voices[1]?.start).toHaveBeenCalledWith(0.16);
  });

  it("only explicit previews play while muted; rapid previews replace and disconnect previous nodes", async () => {
    const { context, voices, gains, buffers, fetchSample } = audioHarness();
    const { result, unmount, state } = mount({ answerSoundEnabled: false, answerSoundId: "bell" });
    expect(context.createOscillator).not.toHaveBeenCalled();
    const signatures: string[] = [];
    for (const sound of ANSWER_SOUNDS) {
      const start = voices.length;
      const sampleStart = buffers.length;
      expect(await result.current.previewAnswerSound(sound.value)).toBe(true);
      signatures.push(JSON.stringify({ samples: buffers.slice(sampleStart).map((node) => node.buffer), voices: voices.slice(start).map((voice) => ({
        frequency: voice.frequency.setValueAtTime.mock.calls,
        ramp: voice.frequency.exponentialRampToValueAtTime.mock.calls,
        timing: voice.start.mock.calls
      })) }));
    }
    expect(new Set(signatures).size).toBe(10);
    expect(buffers).toHaveLength(6);
    expect(fetchSample.mock.calls.map(([url]) => url)).toEqual([
      "/sounds/answer/soft-bell.wav", "/sounds/answer/warm-success.wav", "/sounds/answer/marimba.wav",
      "/sounds/answer/gentle-pop.wav", "/sounds/answer/minimal-confirm.wav", "/sounds/answer/liquid-bubble.wav"
    ]);
    expect(state.preferences).toEqual({ answerSoundEnabled: false, answerSoundId: "bell" });
    expect(faviconPath()).toBeNull();
    expect(voices[0]?.stop).toHaveBeenCalledTimes(2);
    expect(gains[0]?.disconnect).toHaveBeenCalledOnce();
    unmount();
    expect(context.close).toHaveBeenCalledOnce();
    expect(voices.every((voice) => voice.disconnect.mock.calls.length === 1)).toBe(true);
    expect(buffers.every((node) => node.stop.mock.calls.length === 1 && node.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it("reuses decoded samples and disconnects them after natural completion", async () => {
    const { buffers, context, fetchSample } = audioHarness();
    const { result, unmount } = mount();
    await result.current.previewAnswerSound("marimba");
    buffers[0]?.onended?.();
    expect(buffers[0]?.disconnect).toHaveBeenCalledOnce();
    await result.current.previewAnswerSound("marimba");
    expect(fetchSample).toHaveBeenCalledOnce();
    expect(context.decodeAudioData).toHaveBeenCalledOnce();
    expect(buffers[1]?.buffer).toBe(buffers[0]?.buffer);
    unmount();
    expect(buffers[1]?.stop).toHaveBeenCalledOnce();
    expect(buffers[1]?.disconnect).toHaveBeenCalledOnce();
  });

  it.each(["mute", "account", "unmount", "replacement"])("suppresses a sample decoded after %s", async (change) => {
    const { buffers, context, fetchSample, voices } = audioHarness();
    let finish!: (buffer: AudioBuffer) => void;
    context.decodeAudioData.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { result, state, rerender, unmount } = mount({ answerSoundEnabled: true, answerSoundId: "soft-bell" });
    const pending = result.current.notifyAnswerReady();
    await waitFor(() => expect(context.decodeAudioData).toHaveBeenCalledOnce());
    if (change === "mute") state.preferences!.answerSoundEnabled = false;
    if (change === "account") rerender({ accountId: "account-b" });
    if (change === "unmount") unmount();
    if (change === "replacement") expect(await result.current.previewAnswerSound("drop")).toBe(true);
    await act(async () => { finish({} as AudioBuffer); await pending; });
    expect(buffers).toHaveLength(0);
    expect(voices).toHaveLength(change === "replacement" ? 1 : 0);
    if (change !== "mute") expect(fetchSample.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("uses the new selection when it changes while the previous sample is decoding", async () => {
    const { buffers, context, fetchSample } = audioHarness();
    let finish!: (buffer: AudioBuffer) => void;
    context.decodeAudioData.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result, state } = mount({ answerSoundEnabled: true, answerSoundId: "soft-bell" });
    const pending = result.current.notifyAnswerReady();
    await waitFor(() => expect(context.decodeAudioData).toHaveBeenCalledOnce());
    state.preferences!.answerSoundId = "liquid-bubble";
    await act(async () => { finish({} as AudioBuffer); await pending; });
    expect(fetchSample).toHaveBeenCalledTimes(2);
    expect(buffers).toHaveLength(1);
    expect(buffers[0]?.buffer).toEqual({ source: "/sounds/answer/liquid-bubble.wav" });
  });

  it.each(["http", "network", "decode"])("keeps sample failure safe and allows an explicit retry: %s", async (failure) => {
    const { buffers, context, fetchSample } = audioHarness();
    if (failure === "http") fetchSample.mockResolvedValueOnce(new Response(null, { status: 404 }));
    if (failure === "network") fetchSample.mockRejectedValueOnce(new Error("offline"));
    if (failure === "decode") context.decodeAudioData.mockRejectedValueOnce(new Error("invalid audio"));
    const { result } = mount({ answerSoundEnabled: true, answerSoundId: "warm-success" });
    await expect(result.current.notifyAnswerReady()).resolves.toBeUndefined();
    expect(faviconPath()).toBe("/favicon-alert.svg");
    expect(buffers).toHaveLength(0);
    await expect(result.current.previewAnswerSound("warm-success")).resolves.toBe(true);
    expect(buffers).toHaveLength(1);
    expect(fetchSample).toHaveBeenCalledTimes(2);
  });

  it("aborts a stalled sample request after five seconds without delayed playback", async () => {
    vi.useFakeTimers();
    const { buffers, fetchSample } = audioHarness();
    fetchSample.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const { result } = mount();
    const pending = result.current.previewAnswerSound("gentle-pop");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await expect(pending).resolves.toBe(false);
    expect(fetchSample.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(buffers).toHaveLength(0);
    expect(faviconPath()).toBeNull();
  });

  it("replaces a preview whose audio initialization is still waiting", async () => {
    const { context, voices } = audioHarness();
    context.state = "suspended";
    const resumes: Array<() => void> = [];
    context.resume.mockImplementation(() => new Promise<void>((resolve) => resumes.push(resolve)));
    const { result } = mount({ answerSoundEnabled: false, answerSoundId: "rise" });
    const first = result.current.previewAnswerSound("bell");
    const second = result.current.previewAnswerSound("drop");
    context.state = "running";
    resumes.forEach((resume) => resume());
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(voices).toHaveLength(1);
    expect(voices[0]?.frequency.setValueAtTime).toHaveBeenCalledWith(660, 0);
  });

  it("disconnects naturally ended nodes and restores visible favicon feedback after its timeout", async () => {
    vi.useFakeTimers();
    const { voices, gains } = audioHarness();
    const { result } = mount();
    await result.current.notifyAnswerReady();
    voices[0]?.onended?.();
    expect(voices[0]?.disconnect).toHaveBeenCalledOnce();
    expect(gains[0]?.disconnect).toHaveBeenCalledOnce();
    expect(faviconPath()).toBe("/favicon-alert.svg");
    act(() => vi.advanceTimersByTime(1800));
    expect(faviconPath()).toBe("/favicon.svg");
  });

  it.each(["missing", "constructor", "resume", "schedule"])("keeps completion and preview safe when audio fails: %s", async (failure) => {
    const { context } = audioHarness();
    if (failure === "missing") vi.stubGlobal("AudioContext", undefined);
    if (failure === "constructor") vi.stubGlobal("AudioContext", function () { throw new Error("denied"); });
    if (failure === "resume") { context.state = "suspended"; context.resume.mockRejectedValue(new Error("denied")); }
    if (failure === "schedule") context.createGain.mockImplementation(() => { throw new Error("denied"); });
    const { result } = mount();
    await expect(result.current.primeAnswerSound()).resolves.toBeUndefined();
    await expect(result.current.notifyAnswerReady()).resolves.toBeUndefined();
    expect(faviconPath()).toBe("/favicon-alert.svg");
    await expect(result.current.previewAnswerSound("rise")).resolves.toBe(false);
  });
});
