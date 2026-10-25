import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webhookCurlExample, WebhookTokenReveal } from "./WebhookTokenReveal";

const publicId = "AbCdEfGhIjKlMnOpQrSt_-";
const url = `https://ai.example.test/api/automations/hooks/${publicId}`;
const tokenA = `aiqsa_wh_${"A".repeat(43)}`;
const tokenB = `aiqsa_wh_${"B".repeat(43)}`;
const issued = (token: string, issuedAt = "2026-10-25T08:00:00.000Z") =>
  new Response(JSON.stringify({ token, url, issuedAt }), { headers: { "content-type": "application/json" }, status: 200 });

let storageWrites: ReturnType<typeof vi.fn>;

beforeEach(() => {
  storageWrites = vi.fn();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(storageWrites);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let tasks = 0;

/** A reveal of its own task unless one is named: a token a test showed stays parked for a moment after its unmount. */
function renderReveal(props: Partial<Parameters<typeof WebhookTokenReveal>[0]> = {}) {
  const onIssued = vi.fn();
  const taskId = props.taskId ?? `task-${tasks += 1}`;
  const view = render(<WebhookTokenReveal url={url} issued={false} onIssued={onIssued} {...props} taskId={taskId} />);
  return { ...view, onIssued, taskId };
}

describe("WebhookTokenReveal", () => {
  it("shows the address and issues the token once with one click, with Copy and a curl request using the header", async () => {
    const fetchMock = vi.fn(async () => issued(tokenA));
    vi.stubGlobal("fetch", fetchMock);
    const clipboard = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: clipboard } });
    const { onIssued } = renderReveal({ taskId: "task one" });
    expect(screen.getByTestId("webhook-url")).toHaveTextContent(url);
    expect(screen.queryByTestId("webhook-token")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Get token" }));
    await waitFor(() => expect(screen.getByTestId("webhook-token")).toHaveTextContent(tokenA));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/me/scheduled-tasks/task%20one/webhook-token",
      { cache: "no-store", credentials: "same-origin", method: "POST" });
    // The issue time reaches the parent, never the token.
    expect(onIssued).toHaveBeenCalledExactlyOnceWith("2026-10-25T08:00:00.000Z");
    expect(screen.getByTestId("webhook-token")).toHaveFocus();
    const curl = screen.getByTestId("webhook-curl").textContent ?? "";
    expect(curl).toBe(webhookCurlExample(url, tokenA));
    expect(curl).toContain(`-H 'Authorization: Bearer ${tokenA}'`);
    expect(curl).toContain(`curl -X POST '${url}'`);
    // Never in the URL.
    expect(curl).not.toContain(`${url}?`);
    expect(screen.getByText(/X-Gitlab-Token/u)).toBeVisible();
    expect(screen.getByText(/shown only this once/u)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Copy webhook token" }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(tokenA));
    fireEvent.click(screen.getByRole("button", { name: "Copy curl" }));
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(webhookCurlExample(url, tokenA)));
    fireEvent.click(screen.getByRole("button", { name: "Copy webhook URL" }));
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(url));

    // Hide forgets it; the action now rotates.
    fireEvent.click(screen.getByRole("button", { name: "Hide token" }));
    expect(screen.queryByTestId("webhook-token")).toBeNull();
    expect(document.body).not.toHaveTextContent(tokenA);
    expect(screen.getByRole("button", { name: "Rotate token" })).toBeVisible();
    expect(storageWrites).not.toHaveBeenCalled();
  });

  it("rotates with a new call on the next click and shows only the new token", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(issued(tokenA)).mockResolvedValueOnce(issued(tokenB, "2026-10-25T09:00:00.000Z"));
    vi.stubGlobal("fetch", fetchMock);
    const { onIssued } = renderReveal();
    fireEvent.click(screen.getByRole("button", { name: "Get token" }));
    await waitFor(() => expect(screen.getByTestId("webhook-token")).toHaveTextContent(tokenA));
    fireEvent.click(screen.getByRole("button", { name: "Rotate token" }));
    await waitFor(() => expect(screen.getByTestId("webhook-token")).toHaveTextContent(tokenB));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.body).not.toHaveTextContent(tokenA);
    expect(onIssued).toHaveBeenLastCalledWith("2026-10-25T09:00:00.000Z");
    expect(storageWrites).not.toHaveBeenCalled();
  });

  it("offers Rotate token for a webhook issued before, and says what rotating does", () => {
    renderReveal({ issued: true });
    expect(screen.getByRole("button", { name: "Rotate token" })).toBeVisible();
    expect(screen.getByText(/Rotating replaces it at once/u)).toBeVisible();
  });

  it("explains a webhook that is off, a task that is gone and a lost connection, without a token", async () => {
    const cases: Array<[() => Promise<Response>, RegExp]> = [
      [async () => new Response(JSON.stringify({ error: "scheduled_task_webhook_off" }), { status: 409 }), /Turn on the webhook/u],
      [async () => new Response(JSON.stringify({ error: "scheduled_task_not_found" }), { status: 404 }), /no longer available/u],
      [async () => { throw new TypeError("Failed to fetch"); }, /Check your connection/u],
      // A malformed answer is a failure, never a guessed token.
      [async () => new Response(JSON.stringify({ token: "secret", url, issuedAt: "now" }), { status: 200 }), /unavailable right now/u]
    ];
    for (const [answer, message] of cases) {
      vi.stubGlobal("fetch", vi.fn(answer));
      const { onIssued, unmount } = renderReveal();
      fireEvent.click(screen.getByRole("button", { name: "Get token" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(message);
      expect(screen.queryByTestId("webhook-token")).toBeNull();
      expect(onIssued).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Get token" })).toBeEnabled();
      unmount();
    }
  });

  it("stops showing a token whose rotation failed, since it may have been replaced", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(issued(tokenA)).mockRejectedValueOnce(new TypeError("Failed to fetch")));
    renderReveal();
    fireEvent.click(screen.getByRole("button", { name: "Get token" }));
    await waitFor(() => expect(screen.getByTestId("webhook-token")).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "Rotate token" }));
    await screen.findByRole("alert");
    expect(document.body).not.toHaveTextContent(tokenA);
  });

  it("keeps the token only while mounted and ignores an answer after unmount", async () => {
    let resolve: (response: Response) => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    const { onIssued, taskId, unmount } = renderReveal();
    const group = screen.getByRole("group", { name: "Webhook" });
    fireEvent.click(within(group).getByRole("button", { name: "Get token" }));
    // A busy action refuses a second request.
    expect(within(group).getByRole("button", { name: "Get token" })).toBeDisabled();
    unmount();
    await act(async () => resolve(issued(tokenA)));
    expect(onIssued).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent(tokenA);
    // A new mount of the same task starts without it.
    renderReveal({ issued: true, taskId });
    expect(screen.queryByTestId("webhook-token")).toBeNull();
    expect(storageWrites).not.toHaveBeenCalled();
  });

  it("hands a shown token only to a reveal of the same task that mounts again at once", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => issued(tokenA)));
    const first = renderReveal();
    fireEvent.click(screen.getByRole("button", { name: "Get token" }));
    await waitFor(() => expect(screen.getByTestId("webhook-token")).toBeVisible());
    // A settling answer renders its card anew.
    first.unmount();
    const again = renderReveal({ issued: true, taskId: first.taskId });
    expect(screen.getByTestId("webhook-token")).toHaveTextContent(tokenA);
    expect(screen.getByRole("button", { name: "Rotate token" })).toBeVisible();
    // Another task never sees it.
    again.unmount();
    renderReveal();
    expect(document.body).not.toHaveTextContent(tokenA);
    cleanup();

    // Later, or after Hide, it is gone.
    vi.useFakeTimers();
    try {
      const shown = renderReveal({ taskId: first.taskId });
      expect(screen.getByTestId("webhook-token")).toBeVisible();
      shown.unmount();
      vi.advanceTimersByTime(5_001);
      renderReveal({ taskId: first.taskId });
      expect(document.body).not.toHaveTextContent(tokenA);
    } finally {
      vi.useRealTimers();
    }
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => issued(tokenB)));
    const hidden = renderReveal();
    fireEvent.click(screen.getByRole("button", { name: "Get token" }));
    await waitFor(() => expect(screen.getByTestId("webhook-token")).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "Hide token" }));
    hidden.unmount();
    renderReveal({ taskId: hidden.taskId });
    expect(document.body).not.toHaveTextContent(tokenB);
    expect(storageWrites).not.toHaveBeenCalled();
  });
});
