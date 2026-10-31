import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserLiveControlPath,
  browserLiveHandoffPath,
  browserLiveInputPath,
  browserLiveStreamPath,
  type BrowserHandoffReason,
  type BrowserLiveHandoff
} from "@/lib/contracts/browserLive";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import type { ThreadWorkspaceActivity } from "@/lib/contracts/workspace";
import { BrowserLivePanelV2 } from "./BrowserLivePanelV2";
import { fakeEventSources, liveAgent, liveFrame, liveState, type FakeBrowserLiveEventSource } from "./browserLive.testFixtures";

const CHAT = "chat-1";

const browsing: ThreadWorkspaceActivity = { entries: [{
  id: "command-1", kind: "command", phase: "succeeded", command: {
    preview: "aiqsa-browser open https://shop.example/",
    stdoutPreview: "[browser #1] open @ shop.example/\n[browser #2] click: button \"Cart\" @ shop.example/cart"
  }
}] };

const handoffCall: ThreadToolActivity = { calls: [{ round: 2, status: "running", toolName: "browser_handoff" }] };

function handoff(reason: BrowserHandoffReason, overrides: Partial<BrowserLiveHandoff> = {}): BrowserLiveHandoff {
  return { id: "handoff-1", agent: { id: "main", name: null }, reason, message: "Please sign in with your own account.",
    startedAt: new Date(Date.now() - 5_000).toISOString(), expiresAt: new Date(Date.now() + 125_000).toISOString(), ...overrides };
}

let fetchMock: ReturnType<typeof vi.fn>;
let sources: FakeBrowserLiveEventSource[];
let openSource: (url: string) => FakeBrowserLiveEventSource;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  const fake = fakeEventSources();
  sources = fake.sources;
  openSource = fake.open;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderPanel(props: Partial<Parameters<typeof BrowserLivePanelV2>[0]> = {}) {
  return render(<BrowserLivePanelV2 chatId={CHAT} live openEventSource={openSource} toolActivity={null}
    workspaceActivity={browsing} {...props} />);
}

function send(type: string, data: unknown, source = sources.at(-1)!) {
  act(() => source.send(type, data));
}

function posted(): Array<[string, unknown]> {
  return fetchMock.mock.calls.map(([path, init]) => [String(path), JSON.parse(String((init as RequestInit).body))]);
}

function stubFrameBox() {
  const image = screen.getByTestId("browser-live-stage").querySelector("img")!;
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
    left: 100, top: 50, width: 640, height: 400, right: 740, bottom: 450, x: 100, y: 50, toJSON: () => ({})
  } as DOMRect);
}

async function openAsUser() {
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: /Watch/u }));
  send("state", liveState({ controller: "user" }));
  send("frame", liveFrame(1));
  stubFrameBox();
}

describe("BrowserLivePanelV2", () => {
  it("shows nothing without browser activity or once the run ended", () => {
    const { rerender } = renderPanel({ workspaceActivity: { entries: [{ id: "c", kind: "command", phase: "succeeded",
      command: { preview: "echo '[browser #1] open @ x/'", stdoutPreview: "[browser #1] open @ x/" } }] } });
    expect(screen.queryByRole("region", { name: "Browser" })).toBeNull();
    rerender(<BrowserLivePanelV2 chatId={CHAT} live={false} openEventSource={openSource} toolActivity={null} workspaceActivity={browsing} />);
    expect(screen.queryByRole("region", { name: "Browser" })).toBeNull();
    expect(sources).toHaveLength(0);
  });

  it("starts collapsed with the last step and streams only while expanded", () => {
    renderPanel({ workspaceActivity: { entries: [{ id: "c", kind: "command", phase: "running",
      command: { preview: "aiqsa-browser open https://shop.example/" } }] } });
    const region = screen.getByRole("region", { name: "Browser" });
    expect(region).toHaveTextContent("The agent is using the browser");
    expect(sources).toHaveLength(0);
    cleanup();

    renderPanel();
    const bar = screen.getByRole("button", { name: /Watch/u });
    expect(bar).toHaveAttribute("aria-expanded", "false");
    expect(bar).toHaveTextContent("Clicked button \"Cart\"");
    expect(sources).toHaveLength(0);
    fireEvent.click(bar);
    expect(bar).toHaveAttribute("aria-expanded", "true");
    expect(sources[0]!.url).toBe(browserLiveStreamPath(CHAT));
    expect(screen.getByText("Connecting to the browser…")).toBeVisible();
    send("state", liveState());
    send("frame", liveFrame(1));
    send("steps", { agent: "main", steps: [
      { n: 1, action: "open", target: "", host: "shop.example", path: "/" },
      { n: 2, action: "type", target: "textbox \"Search\"", host: "shop.example", path: "/" }
    ] });
    const stage = screen.getByRole("img", { name: "Live view of the agent's browser: Cart · Shop" });
    expect(stage.querySelector("img")).toHaveAttribute("src", expect.stringMatching(/^data:image\/jpeg;base64,/u));
    expect(screen.getByText("https://shop.example/cart")).toBeVisible();
    expect(screen.getByText("The agent is using the browser")).toBeVisible();
    const steps = screen.getByRole("list", { name: "Browser steps" });
    expect(within(steps).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Opened shop.example/", "Typed into textbox \"Search\""]);
    expect(screen.getByRole("status")).toHaveTextContent("The agent has control of the browser.");
    fireEvent.click(screen.getByRole("button", { name: /Hide/u }));
    expect(sources[0]!.closed).toBe(true);
    expect(screen.queryByTestId("browser-live-stage")).toBeNull();
  });

  it.each([
    ["sign_in", "Sign in to shop.example"],
    ["verification_code", "Enter the verification code"],
    ["captcha", "Complete the check on the page"],
    ["consent", "Review the consent request"],
    ["user_choice", "Make a choice on the page"],
    ["other", "The agent needs your help"]
  ] as const)("opens itself for a %s handoff with a plain title", (reason, title) => {
    renderPanel({ toolActivity: handoffCall });
    expect(screen.getByRole("button", { name: /Hide/u })).toHaveTextContent("Needs your help");
    send("state", liveState({ controller: "user", handoff: handoff(reason) }));
    const card = screen.getByTestId("browser-live-handoff");
    expect(within(card).getByRole("heading", { level: 3 })).toHaveTextContent(title);
    expect(card).toHaveTextContent("Please sign in with your own account.");
    expect(card).toHaveTextContent(/2:0[45] left/u);
    expect(card).not.toHaveTextContent("will need to sign in again");
    // During a handoff the user is in control by definition: no Take or Return.
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Return control" })).toBeNull();
  });

  it("shows a waiting background sub-agent's handoff without browsing of its own, naming the agent, and answers it", async () => {
    // A settled answer: no activity of its own, only the chat's sub-agent that waits for the user.
    renderPanel({ toolActivity: null, waitingKey: "thread-signer", workspaceActivity: null });
    expect(screen.getByRole("button", { name: /Hide/u })).toHaveTextContent("Needs your help");
    expect(sources).toHaveLength(1);
    const signer = handoff("sign_in", { agent: { id: "thread-signer", name: "signer" } });
    send("state", liveState({ agents: [liveAgent("thread-signer", "signer", { controller: "user", waitingForUser: true })],
      controller: "user", handoff: signer, selected: "thread-signer" }));
    const card = screen.getByTestId("browser-live-handoff");
    // Alone in the browser, a sub-agent is still named.
    expect(card).toHaveTextContent("Asked by signer");
    fireEvent.click(within(card).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(posted()).toEqual([[browserLiveHandoffPath(CHAT), { action: "done", handoffId: "handoff-1" }]]));
  });

  it("shows nothing for a settled answer once no sub-agent waits", () => {
    renderPanel({ toolActivity: null, waitingKey: null, workspaceActivity: null });
    expect(screen.queryByRole("region", { name: "Browser" })).toBeNull();
    expect(sources).toHaveLength(0);
  });

  it("answers the handoff with Done or Cancel, says when it will not be remembered, and shows a stale answer", async () => {
    renderPanel({ toolActivity: handoffCall });
    send("state", liveState({ controller: "user", signInRemembered: false, handoff: handoff("sign_in") }));
    const card = screen.getByTestId("browser-live-handoff");
    expect(card).toHaveTextContent("This chat does not save browser sign-ins");
    fireEvent.click(within(card).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(posted()).toEqual([[browserLiveHandoffPath(CHAT), { action: "done", handoffId: "handoff-1" }]]));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: "browser_live_handoff_stale" }), { status: 409 }));
    fireEvent.click(within(card).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This request has already ended.");
    expect(posted()[1]).toEqual([browserLiveHandoffPath(CHAT), { action: "cancel", handoffId: "handoff-1" }]);
  });

  it("keeps Done and Cancel usable when the client clock says the time is up", async () => {
    renderPanel({ toolActivity: handoffCall });
    send("state", liveState({ controller: "user", handoff: handoff("captcha", { expiresAt: new Date(Date.now() - 1_000).toISOString() }) }));
    const card = screen.getByTestId("browser-live-handoff");
    expect(card).toHaveTextContent("Time is up");
    expect(card).toHaveTextContent("Your keystrokes are not sent to the agent. When you press Done, the agent continues from the page as you leave it.");
    // The server, not the client clock, decides: a late Done gets its own refusal.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: "browser_live_handoff_stale" }), { status: 409 }));
    fireEvent.click(within(card).getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This request has already ended.");
    expect(within(card).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("scrolls the handoff card into view once per handoff, without taking focus", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderPanel({ toolActivity: handoffCall });
    send("state", liveState({ controller: "user", handoff: handoff("sign_in") }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: "nearest" }));
    expect(document.activeElement).toBe(document.body);
    // Closing and opening the panel again does not scroll a second time.
    fireEvent.click(screen.getByRole("button", { name: /Hide/u }));
    fireEvent.click(screen.getByRole("button", { name: /Watch/u }));
    send("state", liveState({ controller: "user", handoff: handoff("sign_in") }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    send("state", liveState({ controller: "user", handoff: handoff("verification_code", { id: "handoff-2" }) }));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("frees held keys and buttons before control ends, and when focus leaves the view", async () => {
    await openAsUser();
    const stage = screen.getByTestId("browser-live-stage");
    fireEvent.keyDown(stage, { key: "Shift", code: "ShiftLeft", shiftKey: true });
    fireEvent.keyDown(stage, { key: "Control", code: "ControlLeft", ctrlKey: true });
    fireEvent.keyDown(stage, { key: "a", code: "KeyA", ctrlKey: true });
    fireEvent.pointerDown(stage, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 420, clientY: 250 });
    fireEvent.click(screen.getByRole("button", { name: "Return control" }));
    await waitFor(() => expect(posted().at(-1)?.[0]).toBe(browserLiveControlPath(CHAT)));
    expect(posted().map(([, body]) => body)).toEqual([
      { kind: "key", type: "down", key: "a", code: "KeyA", modifiers: 2 },
      { kind: "mouse", type: "down", x: 640, y: 400, button: "left", clickCount: 1 },
      { kind: "key", type: "up", key: "a", code: "KeyA" },
      { kind: "mouse", type: "up", x: 640, y: 400, button: "left", clickCount: 1 },
      { action: "return" }
    ]);
    cleanup();
    fetchMock.mockClear();

    await openAsUser();
    const again = screen.getByTestId("browser-live-stage");
    again.focus();
    fireEvent.keyDown(again, { key: "ArrowDown", code: "ArrowDown" });
    act(() => again.blur());
    await waitFor(() => expect(posted()).toHaveLength(2));
    expect(posted()[1]![1]).toEqual({ kind: "key", type: "up", key: "ArrowDown", code: "ArrowDown" });
  });

  it("leaves the view with Escape twice to the Browser bar while Done is busy", async () => {
    let finish: (response: Response) => void = () => undefined;
    renderPanel({ toolActivity: handoffCall });
    send("state", liveState({ controller: "user", handoff: handoff("sign_in") }));
    send("frame", liveFrame(1));
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toBeDisabled());
    const stage = screen.getByTestId("browser-live-stage");
    stage.focus();
    fireEvent.keyDown(stage, { key: "Escape", code: "Escape" });
    fireEvent.keyDown(stage, { key: "Escape", code: "Escape" });
    expect(screen.getByRole("button", { name: /Hide/u })).toHaveFocus();
    await act(async () => finish(new Response(null, { status: 204 })));
  });

  it("takes and returns control", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Watch/u }));
    send("state", liveState());
    send("frame", liveFrame(1));
    expect(screen.queryByRole("textbox", { name: "Type into the page" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(posted()).toEqual([[browserLiveControlPath(CHAT), { action: "take" }]]));
    send("state", liveState({ controller: "user" }));
    expect(screen.getByText("You have control · the agent waits")).toBeVisible();
    expect(screen.getByRole("button", { name: /Hide/u })).toHaveTextContent("You have control");
    expect(screen.getByRole("textbox", { name: "Type into the page" })).toBeInTheDocument();
    expect(screen.getByRole("application", { name: /Live view/u })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Return control" }));
    await waitFor(() => expect(posted()[1]).toEqual([browserLiveControlPath(CHAT), { action: "return" }]));
  });

  it("maps pointer and keyboard input to frame pixels while the user controls", async () => {
    await openAsUser();
    const stage = screen.getByTestId("browser-live-stage");
    fireEvent.pointerDown(stage, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 420, clientY: 250 });
    fireEvent.pointerUp(stage, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 420, clientY: 250 });
    fireEvent.keyDown(stage, { key: "a", code: "KeyA" });
    fireEvent.keyDown(stage, { key: "Enter", code: "Enter" });
    fireEvent.keyUp(stage, { key: "Enter", code: "Enter" });
    fireEvent.keyUp(stage, { key: "a", code: "KeyA" });
    await waitFor(() => expect(posted()).toHaveLength(5));
    expect(posted()).toEqual([
      [browserLiveInputPath(CHAT), { kind: "mouse", type: "down", x: 640, y: 400, button: "left", clickCount: 1 }],
      [browserLiveInputPath(CHAT), { kind: "mouse", type: "up", x: 640, y: 400, button: "left", clickCount: 1 }],
      [browserLiveInputPath(CHAT), { kind: "text", text: "a" }],
      [browserLiveInputPath(CHAT), { kind: "key", type: "down", key: "Enter", code: "Enter" }],
      [browserLiveInputPath(CHAT), { kind: "key", type: "up", key: "Enter", code: "Enter" }]
    ]);
  });

  it("leaves the view with Escape twice, sending only the first Escape to the page", async () => {
    await openAsUser();
    const stage = screen.getByTestId("browser-live-stage");
    stage.focus();
    fireEvent.keyDown(stage, { key: "Escape", code: "Escape" });
    fireEvent.keyUp(stage, { key: "Escape", code: "Escape" });
    fireEvent.keyDown(stage, { key: "Escape", code: "Escape" });
    expect(screen.getByRole("button", { name: "Return control" })).toHaveFocus();
    await waitFor(() => expect(posted()).toHaveLength(2));
    expect(posted().map(([, body]) => body)).toEqual([
      { kind: "key", type: "down", key: "Escape", code: "Escape" },
      { kind: "key", type: "up", key: "Escape", code: "Escape" }
    ]);
  });

  it("maps a touch tap and sends nothing while the agent controls", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Watch/u }));
    send("state", liveState());
    send("frame", liveFrame(1));
    stubFrameBox();
    const stage = screen.getByTestId("browser-live-stage");
    fireEvent.pointerDown(stage, { pointerId: 1, pointerType: "touch", clientX: 200, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerId: 1, pointerType: "touch", clientX: 200, clientY: 100 });
    fireEvent.keyDown(stage, { key: "a", code: "KeyA" });
    send("state", liveState({ controller: "user" }));
    stubFrameBox();
    fireEvent.pointerDown(stage, { pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100 });
    await waitFor(() => expect(posted()).toHaveLength(2));
    expect(posted().map(([, body]) => body)).toEqual([
      { kind: "mouse", type: "down", x: 200, y: 100, button: "left", clickCount: 1 },
      { kind: "mouse", type: "up", x: 200, y: 100, button: "left", clickCount: 1 }
    ]);
  });

  it("types through the phone field: words, Backspace, Enter and Tab", async () => {
    await openAsUser();
    const field = screen.getByRole("textbox", { name: "Type into the page" });
    act(() => {
      field.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: "hi", inputType: "insertText" }));
    });
    fireEvent.compositionStart(field);
    fireEvent.compositionEnd(field, { data: "привет" });
    act(() => {
      field.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" }));
    });
    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Press Tab in the page" }));
    await waitFor(() => expect(posted()).toHaveLength(8));
    expect(posted().map(([, body]) => body)).toEqual([
      { kind: "text", text: "hi" },
      { kind: "text", text: "привет" },
      { kind: "key", type: "down", key: "Backspace", code: "Backspace" },
      { kind: "key", type: "up", key: "Backspace", code: "Backspace" },
      { kind: "key", type: "down", key: "Enter", code: "Enter" },
      { kind: "key", type: "up", key: "Enter", code: "Enter" },
      { kind: "key", type: "down", key: "Tab", code: "Tab" },
      { kind: "key", type: "up", key: "Tab", code: "Tab" }
    ]);
    expect(field).toHaveValue("");
  });

  it("shows a refusal and drops queued input when the agent has control", async () => {
    await openAsUser();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: "browser_live_not_in_control" }), { status: 409 }));
    fireEvent.keyDown(screen.getByTestId("browser-live-stage"), { key: "x", code: "KeyX" });
    expect(await screen.findByRole("alert")).toHaveTextContent("The agent has control. Take control to use the browser.");
  });

  it("names each state and end reason, and reopens only after replaced or error", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Watch/u }));
    send("state", liveState({ browser: "absent", page: null }));
    const stage = () => within(screen.getByTestId("browser-live-stage"));
    expect(stage().getByText(/The browser has not opened yet/u)).toBeVisible();
    send("state", liveState({ browser: "stopped" }));
    expect(stage().getByText("The browser was closed.")).toBeVisible();
    send("end", { reason: "replaced" });
    expect(stage().getByText("The live view opened in another tab or window.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Watch here" }));
    expect(sources).toHaveLength(2);
    send("end", { reason: "error" });
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(sources).toHaveLength(3);
    send("end", { reason: "run_finished" });
    expect(stage().getByText("The answer finished, so the live view closed.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Reopen|Watch here/u })).toBeNull();
  });

  describe("full screen", () => {
    function openWatching() {
      const view = renderPanel();
      fireEvent.click(screen.getByRole("button", { name: /Watch/u }));
      send("state", liveState());
      send("frame", liveFrame(1));
      return view;
    }

    it("opens a modal layer over the page on the same stream, focuses the page and restores focus on exit", async () => {
      const { container } = openWatching();
      fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
      const layer = screen.getByRole("dialog", { name: "Browser, full screen" });
      expect(layer).toHaveAttribute("aria-modal", "true");
      expect(layer.parentElement?.parentElement).toBe(document.body);
      expect(within(layer).getByTestId("browser-live-stage")).toHaveFocus();
      expect(within(layer).getByRole("img", { name: /Live view/u })).toBeInTheDocument();
      expect(within(layer).getByText("https://shop.example/cart")).toBeInTheDocument();
      expect(within(layer).getByRole("button", { name: "Take control" })).toBeEnabled();
      expect(within(layer).getByRole("button", { name: "Zoom in" })).toBeEnabled();
      // The chat behind is out of reach, and the page does not scroll under the layer.
      expect(container).toHaveAttribute("aria-hidden", "true");
      expect(document.body.style.overflow).toBe("hidden");
      expect(sources).toHaveLength(1);
      // The picture keeps arriving in the layer.
      send("frame", liveFrame(2, 1280, 720));
      expect(within(layer).getByTestId("browser-live-stage").querySelector("img")).toHaveAttribute("height", "720");

      fireEvent.click(within(layer).getByRole("button", { name: "Exit full screen" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(screen.getByRole("button", { name: "Full screen" })).toHaveFocus());
      expect(container).not.toHaveAttribute("aria-hidden");
      expect(document.body.style.overflow).toBe("");
      expect(sources).toHaveLength(1);
      expect(sources[0]!.closed).toBe(false);
    });

    it("leaves with Escape while only watching, sending nothing to the page", async () => {
      openWatching();
      fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
      fireEvent.keyDown(screen.getByTestId("browser-live-stage"), { key: "Escape", code: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(screen.getByRole("button", { name: "Full screen" })).toHaveFocus());
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends a single Escape to the page while the user controls; Escape twice goes to Return control", async () => {
      await openAsUser();
      fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
      const layer = screen.getByRole("dialog", { name: "Browser, full screen" });
      const stage = within(layer).getByTestId("browser-live-stage");
      expect(stage).toHaveFocus();
      expect(within(layer).getByRole("textbox", { name: "Type into the page" })).toBeInTheDocument();
      fireEvent.keyDown(stage, { key: "Escape", code: "Escape" });
      fireEvent.keyUp(stage, { key: "Escape", code: "Escape" });
      expect(screen.getByRole("dialog")).toBe(layer);
      fireEvent.keyDown(stage, { key: "Escape", code: "Escape" });
      expect(within(layer).getByRole("button", { name: "Return control" })).toHaveFocus();
      // Escape on a control while the user controls does not close the layer either.
      fireEvent.keyDown(within(layer).getByRole("button", { name: "Return control" }), { key: "Escape", code: "Escape" });
      expect(screen.getByRole("dialog")).toBe(layer);
      // Nor does an Escape that reaches the page after focus fell out of the layer.
      fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
      expect(screen.getByRole("dialog")).toBe(layer);
      await waitFor(() => expect(posted()).toHaveLength(2));
      expect(posted().map(([, body]) => body)).toEqual([
        { kind: "key", type: "down", key: "Escape", code: "Escape" },
        { kind: "key", type: "up", key: "Escape", code: "Escape" }
      ]);
    });

    it("maps a click on the enlarged frame to frame pixels", async () => {
      await openAsUser();
      fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
      const stage = within(screen.getByRole("dialog")).getByTestId("browser-live-stage");
      vi.spyOn(stage.querySelector("img")!, "getBoundingClientRect").mockReturnValue({
        left: 20, top: 60, width: 1600, height: 1000, right: 1620, bottom: 1060, x: 20, y: 60, toJSON: () => ({})
      } as DOMRect);
      fireEvent.pointerDown(stage, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 420, clientY: 310 });
      fireEvent.pointerUp(stage, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 420, clientY: 310 });
      await waitFor(() => expect(posted()).toHaveLength(2));
      expect(posted().map(([, body]) => body)).toEqual([
        { kind: "mouse", type: "down", x: 320, y: 200, button: "left", clickCount: 1 },
        { kind: "mouse", type: "up", x: 320, y: 200, button: "left", clickCount: 1 }
      ]);
    });

    it("keeps the handoff with Done and Cancel in the layer and focus inside it once the handoff ends", async () => {
      renderPanel({ toolActivity: handoffCall });
      send("state", liveState({ controller: "user", handoff: handoff("sign_in") }));
      send("frame", liveFrame(1));
      fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
      const layer = screen.getByRole("dialog", { name: "Browser, full screen" });
      const card = within(layer).getByTestId("browser-live-handoff");
      expect(within(card).getByRole("heading", { level: 3 })).toHaveTextContent("Sign in to shop.example");
      expect(card).toHaveTextContent("Please sign in with your own account.");
      expect(card).toHaveTextContent(/left/u);
      expect(within(card).getByRole("button", { name: "Cancel" })).toBeEnabled();
      // Escape belongs to the page during a handoff too.
      fireEvent.keyDown(within(card).getByRole("button", { name: "Cancel" }), { key: "Escape", code: "Escape" });
      expect(screen.getByRole("dialog")).toBe(layer);
      fireEvent.click(within(card).getByRole("button", { name: "Done" }));
      await waitFor(() => expect(posted()).toEqual([[browserLiveHandoffPath(CHAT), { action: "done", handoffId: "handoff-1" }]]));
      send("state", liveState());
      expect(within(layer).queryByTestId("browser-live-handoff")).toBeNull();
      expect(within(layer).getByTestId("browser-live-stage")).toHaveFocus();
      fireEvent.click(within(layer).getByRole("button", { name: "Exit full screen" }));
      fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Take control" }));
      await waitFor(() => expect(posted().at(-1)).toEqual([browserLiveControlPath(CHAT), { action: "take" }]));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Exit full screen" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Full screen" })).toHaveFocus());
    });

    it("closes by itself when the browser closes or the run ends, with focus on the Browser bar", async () => {
      const { container } = openWatching();
      fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
      send("state", liveState({ browser: "stopped" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(screen.getByRole("button", { name: /Hide/u })).toHaveFocus());
      expect(container).not.toHaveAttribute("aria-hidden");
      // A new picture does not reopen it.
      send("state", liveState());
      send("frame", liveFrame(2));
      expect(screen.queryByRole("dialog")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
      send("end", { reason: "run_finished" });
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(screen.getByRole("button", { name: /Hide/u })).toHaveFocus());

      // The answer ended: the panel is gone, so focus goes to the composer.
      cleanup();
      const composer = document.body.appendChild(document.createElement("textarea"));
      composer.className = "v2-composer-input";
      const again = openWatching();
      fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
      again.rerender(<BrowserLivePanelV2 chatId={CHAT} live={false} openEventSource={openSource} toolActivity={null} workspaceActivity={browsing} />);
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(composer).toHaveFocus());
      expect(again.container).not.toHaveAttribute("aria-hidden");
      expect(document.body.style.overflow).toBe("");
      composer.remove();
    });
  });

  it("never stores or logs frames or typed text", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((name) => vi.spyOn(console, name));
    await openAsUser();
    fireEvent.keyDown(screen.getByTestId("browser-live-stage"), { key: "s", code: "KeyS" });
    fireEvent.paste(screen.getByTestId("browser-live-stage"), { clipboardData: { getData: () => "secret-marker" } });
    await waitFor(() => expect(posted()).toHaveLength(2));
    expect(posted()[1]![1]).toEqual({ kind: "text", text: "secret-marker" });
    expect(setItem).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe("BrowserLivePanelV2 with several browsing agents", () => {
  const shopHandoff = handoff("sign_in", { id: "handoff-shop", agent: { id: "thread_shop", name: "shop" },
    message: "Please sign in to Swag Labs." });
  const amazonHandoff = handoff("verification_code", { id: "handoff-amazon", agent: { id: "thread_amazon", name: "amazon" },
    message: "Enter the SMS code.", startedAt: new Date(Date.now() - 1_000).toISOString() });
  const agents = (overrides: Readonly<Record<string, Partial<Parameters<typeof liveAgent>[2]>>> = {}) => [
    liveAgent("main", null, overrides.main),
    liveAgent("thread_amazon", "amazon", { page: { url: "https://www.amazon.es/s?k=kettle", title: "Kettles" }, ...overrides.thread_amazon }),
    liveAgent("thread_shop", "shop", { page: { url: "https://www.saucedemo.com/", title: "Swag Labs" }, ...overrides.thread_shop })
  ];

  function openPanel() {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Watch/u }));
  }

  it("looks as before with only the main agent browsing", () => {
    openPanel();
    send("state", liveState());
    expect(screen.queryByTestId("browser-live-agents")).toBeNull();
    expect(screen.getByText("The agent is using the browser")).toBeVisible();
  });

  it("does not count the main agent as browsing while its tab is blank", () => {
    openPanel();
    const blank = agents().map((agent) => agent.id === "main" ? { ...agent, page: { title: "", url: "about:blank" } } : agent);
    send("state", liveState({ agents: blank, selected: "thread_amazon", page: { url: "https://www.amazon.es/", title: "Amazon" } }));
    const select = screen.getByRole("combobox", { name: /2 agents browsing/u });
    expect(within(select).queryByRole("option", { name: /Main agent/u })).toBeNull();
  });

  it("lists the browsing agents with their state and site, and switches the stream to the one picked", async () => {
    openPanel();
    send("state", liveState({ agents: agents({ thread_shop: { controller: "user" } }), selected: "thread_amazon",
      page: { url: "https://www.amazon.es/s?k=kettle", title: "Kettles" } }));
    send("frame", liveFrame(1, 1280, 800, "thread_amazon"));
    const select = screen.getByRole("combobox", { name: /3 agents browsing/u });
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Main agent · browsing · main.example", "amazon · browsing · amazon.es", "shop · you have control · saucedemo.com"]);
    expect(select).toHaveValue("thread_amazon");
    expect(screen.getByText("amazon is using the browser")).toBeVisible();
    fireEvent.change(select, { target: { value: "thread_shop" } });
    await waitFor(() => expect(posted()).toEqual([[browserLiveControlPath(CHAT), { action: "select", agent: "thread_shop" }]]));
    // The new selection arrives: the old agent's picture is not shown as the new one's.
    send("state", liveState({ agents: agents({ thread_shop: { controller: "user" } }), controller: "user", selected: "thread_shop",
      page: { url: "https://www.saucedemo.com/", title: "Swag Labs" } }));
    expect(screen.getByText("Waiting for the page picture…")).toBeVisible();
    send("frame", liveFrame(2, 1280, 800, "thread_amazon"));
    expect(screen.getByText("Waiting for the page picture…")).toBeVisible();
    send("frame", liveFrame(3, 1280, 800, "thread_shop"));
    expect(screen.getByRole("application", { name: /Swag Labs/u })).toBeVisible();
    expect(screen.getByText("You have control · shop waits")).toBeVisible();
  });

  it("takes and returns control of the selected agent's tab and types into that tab only", async () => {
    openPanel();
    send("state", liveState({ agents: agents(), selected: "thread_shop", page: { url: "https://www.saucedemo.com/", title: "Swag Labs" } }));
    send("frame", liveFrame(1, 1280, 800, "thread_shop"));
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(posted()).toEqual([[browserLiveControlPath(CHAT), { action: "take", agent: "thread_shop" }]]));
    send("state", liveState({ agents: agents({ thread_shop: { controller: "user" } }), controller: "user", selected: "thread_shop",
      page: { url: "https://www.saucedemo.com/", title: "Swag Labs" } }));
    stubFrameBox();
    const stage = screen.getByTestId("browser-live-stage");
    fireEvent.keyDown(stage, { key: "x", code: "KeyX" });
    await waitFor(() => expect(posted().at(-1)).toEqual([browserLiveInputPath(CHAT),
      { agent: "thread_shop", kind: "text", text: "x" }]));
    fireEvent.click(screen.getByRole("button", { name: "Return control" }));
    await waitFor(() => expect(posted().at(-1)).toEqual([browserLiveControlPath(CHAT), { action: "return", agent: "thread_shop" }]));
  });

  it("shows the oldest handoff first with its agent and the count of the others, and answers that one", async () => {
    openPanel();
    const waiting = agents({ thread_amazon: { controller: "user", waitingForUser: true }, thread_shop: { controller: "user", waitingForUser: true } });
    send("state", liveState({ agents: waiting, controller: "user", handoff: amazonHandoff, handoffs: [amazonHandoff, shopHandoff],
      selected: "thread_amazon", page: { url: "https://www.amazon.es/ap/cvf", title: "Verify" } }));
    const card = screen.getByTestId("browser-live-handoff");
    expect(card).toHaveAttribute("data-agent", "thread_amazon");
    expect(within(card).getByText("Asked by amazon")).toBeVisible();
    expect(within(card).getByText("1 more request is waiting after this one.")).toBeVisible();
    expect(screen.getByRole("combobox", { name: /3 agents browsing · 2 need you/u })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(posted().at(-1)).toEqual([browserLiveHandoffPath(CHAT), { action: "done", handoffId: "handoff-amazon" }]));
    // The next one moves the stream to its agent.
    send("state", liveState({ agents: agents({ thread_shop: { controller: "user", waitingForUser: true } }), controller: "user",
      handoff: shopHandoff, handoffs: [shopHandoff], selected: "thread_shop", page: { url: "https://www.saucedemo.com/", title: "Swag Labs" } }));
    const next = screen.getByTestId("browser-live-handoff");
    expect(within(next).getByRole("heading", { name: "Sign in to saucedemo.com" })).toBeVisible();
    expect(within(next).queryByTestId("browser-live-handoff-queue")).toBeNull();
    send("frame", liveFrame(1, 1280, 800, "thread_shop"));
    fireEvent.keyDown(screen.getByTestId("browser-live-stage"), { key: "x", code: "KeyX" });
    await waitFor(() => expect(posted().at(-1)).toEqual([browserLiveInputPath(CHAT),
      { agent: "thread_shop", kind: "text", text: "x" }]));
    fireEvent.click(within(next).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(posted().at(-1)).toEqual([browserLiveHandoffPath(CHAT), { action: "cancel", handoffId: "handoff-shop" }]));
  });

  it("offers the asking agent's tab when another one is shown, and still answers the request it names", async () => {
    openPanel();
    send("state", liveState({ agents: agents({ thread_shop: { controller: "user", waitingForUser: true } }), handoff: shopHandoff,
      handoffs: [shopHandoff], selected: "main" }));
    const card = screen.getByTestId("browser-live-handoff");
    expect(within(card).getByRole("heading", { name: "Sign in to saucedemo.com" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Take control" })).toBeVisible();
    fireEvent.click(within(card).getByRole("button", { name: "Show its tab" }));
    await waitFor(() => expect(posted()).toEqual([[browserLiveControlPath(CHAT), { action: "select", agent: "thread_shop" }]]));
    fireEvent.click(within(card).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(posted().at(-1)).toEqual([browserLiveHandoffPath(CHAT), { action: "done", handoffId: "handoff-shop" }]));
  });
});
