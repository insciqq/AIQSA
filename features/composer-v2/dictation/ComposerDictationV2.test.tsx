import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composerGalleryConfig } from "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";
import type { CatalogDictation } from "@/lib/contracts/speechToText";
import { ComposerV2 } from "../ComposerV2";
import { insertDictatedText } from "./ComposerDictationV2";

const READY: CatalogDictation = { available: true, unavailableReason: null };

/** A controllable MediaRecorder: tests emit data and stop through it. */
class FakeMediaRecorder extends EventTarget {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = vi.fn((type: string) => type === "audio/webm;codecs=opus");
  readonly mimeType: string;
  state: "inactive" | "recording" = "inactive";
  constructor(readonly stream: MediaStream, options?: { mimeType?: string }) {
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

  it("stops by itself after five minutes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness initial="" />);
    await record();
    respond({ text: "long talk" });
    await act(async () => { vi.advanceTimersByTime(5 * 60 * 1_000); });
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
    [{ error: "audio_too_large" }, 413, "too long to transcribe"],
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

describe("insertDictatedText", () => {
  it("separates words, replaces a selection and appends without a caret", () => {
    expect(insertDictatedText("", "hi", { end: 0, start: 0 })).toEqual({ caret: 2, draft: "hi" });
    expect(insertDictatedText("ab", "x", { end: 1, start: 1 })).toEqual({ caret: 3, draft: "a x b" });
    expect(insertDictatedText("a b", "x", { end: 2, start: 2 })).toEqual({ caret: 3, draft: "a x b" });
    expect(insertDictatedText("one two", "three", { end: 7, start: 4 })).toEqual({ caret: 9, draft: "one three" });
    expect(insertDictatedText("end", "more", null)).toEqual({ caret: 8, draft: "end more" });
  });
});
