import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composerGalleryConfig } from "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";
import {
  DICTATION_MAX_DURATION_MS,
  DICTATION_RECORDER_BITS_PER_SECOND,
  type CatalogDictation
} from "@/lib/contracts/speechToText";
import { ComposerV2 } from "../ComposerV2";
import { insertDictatedText } from "./ComposerDictationV2";

const READY: CatalogDictation = { available: true, unavailableReason: null };

/** A controllable MediaRecorder: tests emit data and stop through it. */
class FakeMediaRecorder extends EventTarget {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = vi.fn((type: string) => type === "audio/webm;codecs=opus");
  readonly mimeType: string;
  state: "inactive" | "recording" = "inactive";
  constructor(readonly stream: MediaStream, readonly options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }
  start() { this.state = "recording"; }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    const data = Object.assign(new Event("dataavailable"), { data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1])], { type: this.mimeType }) });
    this.dispatchEvent(data);
    this.dispatchEvent(new Event("stop"));
  }
}

const track = { stop: vi.fn() };
const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
let secure = true;

function Harness({ dictation = READY, disabledReason = null, initial = "Hello world", sessionKey = "chat-1" }: Readonly<{
  dictation?: CatalogDictation | null; disabledReason?: string | null; initial?: string; sessionKey?: string;
}>) {
  const [draft, setDraft] = useState(initial);
  return <ComposerV2 config={composerGalleryConfig} dictation={dictation} disabledReason={disabledReason} draft={draft}
    onDraftChange={setDraft} selectedModelId="gpt-5.2" selectedProvider="openai-work" sessionKey={sessionKey} onSend={vi.fn()} />;
}

function respond(body: unknown, status = 200) {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(body, { status }));
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  secure = true;
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("fetch", vi.fn());
  Object.defineProperty(window, "isSecureContext", { configurable: true, get: () => secure });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  getUserMedia.mockClear();
  track.stop.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function record() {
  fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
  await screen.findByRole("group", { name: "Dictation" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Stop dictation and transcribe" })).toBeEnabled());
}

describe("composer dictation", () => {
  it("shows no microphone without the administrator role", () => {
    const view = render(<Harness dictation={null} />);
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
    view.rerender(<Harness dictation={{ available: false, unavailableReason: "not_configured" }} />);
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
  });

  it("records, shows the timer, transcribes and inserts at the caret with spaces, keeping the draft", async () => {
    render(<Harness />);
    const textarea = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    textarea.setSelectionRange(5, 5);
    await record();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(FakeMediaRecorder.instances[0]!.mimeType).toBe("audio/webm;codecs=opus");
    expect(FakeMediaRecorder.instances[0]!.options?.audioBitsPerSecond).toBe(DICTATION_RECORDER_BITS_PER_SECOND);
    expect(screen.getByRole("group", { name: "Dictation" })).toHaveTextContent("0:00");
    respond({ text: "brave new" });
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation and transcribe" }));
    await waitFor(() => expect(textarea).toHaveValue("Hello brave new world"));
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("/api/me/transcriptions");
    const file = (init?.body as FormData).get("file") as File;
    expect(file.type).toBe("audio/webm;codecs=opus");
    expect(file.name).toBe("dictation.webm");
    expect(track.stop).toHaveBeenCalled();
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe("Hello brave new".length);
    expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled();
  });

  it("cancels with Escape or the Cancel button and never uploads", async () => {
    render(<Harness />);
    await record();
    fireEvent.keyDown(document, { key: "Escape" });
    await screen.findByRole("button", { name: "Dictate" });
    await record();
    fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
    await screen.findByRole("button", { name: "Dictate" });
    expect(fetch).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Hello world");
  });

  it("stops by itself at the ten-minute dictation limit", async () => {
    expect(DICTATION_MAX_DURATION_MS).toBe(10 * 60 * 1_000);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness initial="" />);
    await record();
    respond({ text: "long talk" });
    await act(async () => { vi.advanceTimersByTime(DICTATION_MAX_DURATION_MS - 5_000); });
    expect(FakeMediaRecorder.instances[0]!.state).toBe("recording");
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(5_000); });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("long talk"));
  });

  it("discards the recording on a budget refusal with a clear message and an intact draft", async () => {
    render(<Harness />);
    await record();
    respond({ error: "usage_budget_exhausted", usageLimit: { limit: 5_000_000, resetsAt: "2026-11-01T00:00:00.000Z", scope: "user", used: 5_000_000, window: "month" } }, 429);
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation and transcribe" }));
    const alert = await screen.findByTestId("composer-dictation-error");
    expect(alert).toHaveTextContent(/^Recording discarded\. Your monthly budget of \$5\.00 is used up\./u);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Hello world");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("composer-dictation-error")).toBeNull();
  });

  it.each([
    [{ error: "audio_too_large" }, 413, "too long to transcribe. Keep dictations under 10 minutes."],
    [{ error: "transcription_failed" }, 502, "could not be transcribed"],
    [{ error: "dictation_rate_limited" }, 429, "dictated a lot"],
    [{ text: "  " }, 200, "No speech was recognized"]
  ])("humanizes %j", async (body, status, message) => {
    render(<Harness />);
    await record();
    respond(body, status);
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation and transcribe" }));
    expect(await screen.findByTestId("composer-dictation-error")).toHaveTextContent(message);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Hello world");
  });

  it("explains a blocked microphone", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    expect(await screen.findByTestId("composer-dictation-error")).toHaveTextContent("Microphone access is blocked");
    expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled();
  });

  it("is disabled with the reason on plain HTTP, without recording support, while unavailable or blocked by an inline edit", () => {
    secure = false;
    const view = render(<Harness />);
    const mic = () => screen.getByRole("button", { name: "Dictate" });
    expect(mic()).toBeDisabled();
    expect(mic()).toHaveAccessibleDescription(/secure connection \(HTTPS\)/u);
    secure = true;
    view.unmount();
    vi.stubGlobal("MediaRecorder", undefined);
    const second = render(<Harness />);
    expect(mic()).toHaveAccessibleDescription(/cannot record audio/u);
    second.unmount();
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const third = render(<Harness dictation={{ available: false, unavailableReason: "unavailable" }} />);
    expect(mic()).toBeDisabled();
    expect(mic()).toHaveAccessibleDescription(/Dictation is unavailable right now/u);
    third.rerender(<Harness disabledReason="Finish or cancel the inline edit first." />);
    expect(mic()).toBeDisabled();
    expect(mic()).toHaveAccessibleDescription("Finish or cancel the inline edit first.");
  });

  it("discards a dictation when the chat changes", async () => {
    const view = render(<Harness />);
    await record();
    view.rerender(<Harness sessionKey="chat-2" />);
    await screen.findByRole("button", { name: "Dictate" });
    expect(track.stop).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

/** A controllable audio context: tests choose where `resume()` leaves it and move it between states. */
class FakeAudioContext extends EventTarget {
  static instances: FakeAudioContext[] = [];
  static resumesTo: AudioContextState = "running";
  state: AudioContextState = "suspended";
  readonly analyser = { disconnect: vi.fn(), fftSize: 2048, getFloatTimeDomainData: vi.fn((samples: Float32Array) => samples.fill(0.1)) };
  readonly source = { connect: vi.fn(), disconnect: vi.fn() };
  readonly close = vi.fn(async () => { this.move("closed"); });
  readonly resume = vi.fn(async () => { this.move(FakeAudioContext.resumesTo); });
  readonly createAnalyser = vi.fn(() => this.analyser);
  readonly createMediaStreamSource = vi.fn(() => this.source);
  constructor() {
    super();
    FakeAudioContext.instances.push(this);
  }
  move(state: AudioContextState) {
    if (this.state === state) return;
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

describe("composer dictation wave", () => {
  let getContext: { mockRestore(): void };
  beforeEach(() => {
    FakeAudioContext.instances = [];
    FakeAudioContext.resumesTo = "running";
    vi.stubGlobal("AudioContext", FakeAudioContext);
    // jsdom has no 2D canvas: the wave tolerates that by drawing nothing.
    getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });
  afterEach(() => getContext.mockRestore());

  // An inert field has no accessible name, so it is found by its element.
  const message = () => document.querySelector<HTMLTextAreaElement>("textarea.v2-composer-input")!;
  const send = () => screen.getByRole("button", { name: "Send message" });
  const wave = () => screen.queryByTestId("composer-dictation-wave");

  async function expectCovered() {
    await waitFor(() => expect(wave()).not.toBeNull());
    expect(wave()).toHaveAttribute("aria-hidden", "true");
    expect(message()).toHaveAttribute("inert");
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(send()).toBeDisabled();
    expect(send()).toHaveAccessibleDescription("Stop or cancel the dictation to send.");
  }

  function expectFieldAsBefore(draft = "Hello world") {
    expect(wave()).toBeNull();
    expect(message()).not.toHaveAttribute("inert");
    expect(message()).toHaveValue(draft);
    expect(send()).toBeEnabled();
  }

  it("covers the field with the measured level while recording, holds Send, and lands the transcript at the caret after Stop", async () => {
    render(<Harness />);
    message().setSelectionRange(5, 5);
    await record();
    await expectCovered();
    const [context] = FakeAudioContext.instances;
    // Source to analyser only: nothing reaches the speakers.
    expect(context!.createMediaStreamSource).toHaveBeenCalledWith(expect.objectContaining({ getTracks: expect.any(Function) }));
    expect(context!.source.connect).toHaveBeenCalledTimes(1);
    expect(context!.source.connect).toHaveBeenCalledWith(context!.analyser);
    expect(message()).toHaveValue("Hello world");
    respond({ text: "brave new" });
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation and transcribe" }));
    expect(context!.close).toHaveBeenCalledTimes(1);
    expect(wave()).toBeNull();
    await waitFor(() => expect(message()).toHaveValue("Hello brave new world"));
    expect(message()).not.toHaveAttribute("inert");
    expect(document.activeElement).toBe(message());
    expect(message().selectionStart).toBe("Hello brave new".length);
    expect(send()).toBeEnabled();
  });

  it("brings the draft back unchanged on Cancel and Escape, closing each audio context", async () => {
    render(<Harness />);
    await record();
    await expectCovered();
    fireEvent.keyDown(document, { key: "Escape" });
    await screen.findByRole("button", { name: "Dictate" });
    expectFieldAsBefore();
    await record();
    await expectCovered();
    fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
    await screen.findByRole("button", { name: "Dictate" });
    expectFieldAsBefore();
    expect(FakeAudioContext.instances).toHaveLength(2);
    for (const context of FakeAudioContext.instances) {
      expect(context.close).toHaveBeenCalledTimes(1);
      expect(context.source.disconnect).toHaveBeenCalled();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("closes the audio context when the composer unmounts mid-recording", async () => {
    const view = render(<Harness />);
    await record();
    await expectCovered();
    view.unmount();
    expect(FakeAudioContext.instances[0]!.close).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalled();
  });

  it.each([
    ["no AudioContext", () => vi.stubGlobal("AudioContext", undefined)],
    ["an AudioContext that cannot be built", () => vi.stubGlobal("AudioContext", class { constructor() { throw new Error("blocked"); } })],
    ["a context that stays suspended", () => { FakeAudioContext.resumesTo = "suspended"; }]
  ])("keeps the field, typing and Send as before with %s", async (_name, arrange) => {
    arrange();
    render(<Harness />);
    await record();
    // Give a pending resume() its turn before checking that nothing covers the field.
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("group", { name: "Dictation" })).toHaveTextContent("0:00");
    expectFieldAsBefore();
    fireEvent.change(message(), { target: { value: "Hello world, typed" } });
    expect(message()).toHaveValue("Hello world, typed");
    for (const context of FakeAudioContext.instances) {
      fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
      expect(context.close).toHaveBeenCalledTimes(1);
    }
  });

  it("follows the context out of and back into running mid-recording", async () => {
    render(<Harness />);
    await record();
    await expectCovered();
    const [context] = FakeAudioContext.instances;
    act(() => context!.move("suspended"));
    expectFieldAsBefore();
    act(() => context!.move("running"));
    await expectCovered();
    fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
    expect(context!.close).toHaveBeenCalledTimes(1);
  });
});

describe("insertDictatedText", () => {
  it("separates words, replaces a selection and appends without a caret", () => {
    expect(insertDictatedText("", "hi", { end: 0, start: 0 })).toEqual({ caret: 2, draft: "hi" });
    expect(insertDictatedText("ab", "x", { end: 1, start: 1 })).toEqual({ caret: 3, draft: "a x b" });
    expect(insertDictatedText("a b", "x", { end: 2, start: 2 })).toEqual({ caret: 3, draft: "a x b" });
    expect(insertDictatedText("one two", "three", { end: 7, start: 4 })).toEqual({ caret: 9, draft: "one three" });
    expect(insertDictatedText("end", "more", null)).toEqual({ caret: 8, draft: "end more" });
  });
});
