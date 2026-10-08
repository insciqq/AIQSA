import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnswerProblemReportDialogV2 } from "./AnswerProblemReportDialogV2";
import type { AnswerProblemReportLoadResult, AnswerProblemReportSendResult } from "./answerProblemReportApi";

const target = { chatId: "chat-1", messageId: "answer-1" };
const updatedAt = "2026-10-09T12:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const openers: HTMLElement[] = [];

async function renderDialog(input: Readonly<{
  load?: () => Promise<AnswerProblemReportLoadResult>;
  send?: (...args: unknown[]) => Promise<AnswerProblemReportSendResult>;
}> = {}) {
  const onClose = vi.fn();
  const onSent = vi.fn();
  const load = vi.fn(input.load ?? (async (): Promise<AnswerProblemReportLoadResult> => ({ ok: true, report: null })));
  const send = vi.fn(input.send ?? (async (): Promise<AnswerProblemReportSendResult> => ({
    ok: true, outcome: "created", report: { comment: null, reason: "too_slow", updatedAt }
  })));
  const opener = document.createElement("button");
  opener.textContent = "More answer actions";
  document.body.append(opener);
  openers.push(opener);
  const view = render(
    <AnswerProblemReportDialogV2 load={load} onClose={onClose} onSent={onSent} restoreFocus={() => opener} send={send} target={target} />
  );
  // Settles the saved-report read when it is already resolved.
  await act(async () => { await Promise.resolve(); });
  return { ...view, load, onClose, onSent, opener, send };
}

afterEach(() => {
  for (const opener of openers.splice(0)) opener.remove();
  vi.restoreAllMocks();
});

describe("Report a problem dialog", () => {
  it("sends one reason and an optional comment with the administrator notice, then closes", async () => {
    const { load, onClose, onSent, send } = await renderDialog();
    const dialog = screen.getByRole("dialog", { name: "Report a problem" });
    const reasons = within(dialog).getByRole("radiogroup", { name: "What went wrong?" });
    expect(within(reasons).getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)).toEqual([
      "Wrong or made-up answer", "Didn't do what I asked", "Error or something broken", "Too slow", "Other"
    ]);
    expect(within(reasons).getByRole("radio", { name: "Wrong or made-up answer" })).toHaveFocus();
    expect(load).toHaveBeenCalledWith(target, expect.any(AbortSignal));
    const comment = within(dialog).getByRole("textbox", { name: "Comment (optional)" });
    expect(comment).toHaveAccessibleDescription(
      "Administrators will see this report. Your question and the answer are not attached."
    );
    expect(comment).toHaveAttribute("maxLength", "1000");
    const sendButton = within(dialog).getByRole("button", { name: "Send" });
    expect(sendButton).toBeDisabled();

    fireEvent.click(within(reasons).getByRole("radio", { name: "Too slow" }));
    fireEvent.change(comment, { target: { value: "  Took two minutes.  " } });
    fireEvent.click(sendButton);

    await waitFor(() => expect(onSent).toHaveBeenCalledWith("created"));
    expect(send).toHaveBeenCalledWith(target, { comment: "  Took two minutes.  ", reason: "too_slow" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("prefills the saved report and offers Update", async () => {
    const { send } = await renderDialog({ load: async () => ({ ok: true, report: { comment: "It made up a law.", reason: "wrong_or_made_up",
      updatedAt } }) });
    const dialog = screen.getByRole("dialog", { name: "Report a problem" });
    const update = await within(dialog).findByRole("button", { name: "Update" });
    expect(within(dialog).getByRole("radio", { name: "Wrong or made-up answer" })).toBeChecked();
    expect(within(dialog).getByRole("textbox", { name: "Comment (optional)" })).toHaveValue("It made up a law.");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Other" }));
    fireEvent.click(update);
    await waitFor(() => expect(send).toHaveBeenCalledWith(target, { comment: "It made up a law.", reason: "other" }));
  });

  it("keeps a choice the user made before the saved report arrived", async () => {
    const pending = deferred<AnswerProblemReportLoadResult>();
    await renderDialog({ load: () => pending.promise });
    const dialog = screen.getByRole("dialog", { name: "Report a problem" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Too slow" }));
    await act(async () => {
      pending.resolve({ ok: true, report: { comment: "Old", reason: "other", updatedAt } });
      await pending.promise;
    });
    expect(within(dialog).getByRole("radio", { name: "Too slow" })).toBeChecked();
    expect(within(dialog).getByRole("textbox", { name: "Comment (optional)" })).toHaveValue("");
    expect(within(dialog).getByRole("button", { name: "Update" })).toBeEnabled();
  });

  it("announces a refused send and keeps the form", async () => {
    const { onClose, onSent } = await renderDialog({ send: async () => ({ error: "rate_limited", ok: false }) });
    const dialog = screen.getByRole("dialog", { name: "Report a problem" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Other" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Comment (optional)" }), { target: { value: "Draft" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("You have sent many reports today. Try again tomorrow.");
    expect(within(dialog).getByRole("textbox", { name: "Comment (optional)" })).toHaveValue("Draft");
    expect(onSent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says an answer that can no longer be reported cannot be sent", async () => {
    await renderDialog({ load: async () => ({ error: "unavailable", ok: false }) });
    const dialog = screen.getByRole("dialog", { name: "Report a problem" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This answer can no longer be reported.");
    expect(within(dialog).getByRole("radio", { name: "Other" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("shows the remaining length near the limit", async () => {
    await renderDialog();
    const comment = screen.getByRole("textbox", { name: "Comment (optional)" });
    fireEvent.change(comment, { target: { value: "x".repeat(950) } });
    expect(comment).toHaveAccessibleDescription(
      "Administrators will see this report. Your question and the answer are not attached. 50 characters left"
    );
  });

  it("closes with Escape and Cancel, wraps Shift+Tab from the reasons, and blocks closing while sending", async () => {
    const pending = deferred<AnswerProblemReportSendResult>();
    const { onClose } = await renderDialog({ send: () => pending.promise });
    const dialog = screen.getByRole("dialog", { name: "Report a problem" });
    const first = within(dialog).getByRole("radio", { name: "Wrong or made-up answer" });
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(within(dialog).getByRole("button", { name: "Send" })).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(onClose).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.resolve({ error: "failed", ok: false });
      await pending.promise;
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("The report could not be sent. Try again.");
  });

  it("returns focus to the answer's More button when it closes", async () => {
    const { opener, rerender, load, send } = await renderDialog();
    rerender(<div />);
    await waitFor(() => expect(opener).toHaveFocus());
    expect(load).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });
});
