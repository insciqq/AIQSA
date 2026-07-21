import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

function fileList(files: File[]): FileList {
  const list = [...files] as unknown as FileList;

  Object.defineProperty(list, "item", {
    value: (index: number) => files[index] ?? null
  });

  return list;
}

function fileTransfer(files: File[], types = ["Files"]) {
  return {
    dropEffect: "none",
    files: fileList(files),
    types
  } as unknown as DataTransfer;
}

describe("Composer", () => {
  it("keeps writing, controls, attachments, and the labeled send action in one composer surface", () => {
    render(
      <Composer
        attachments={[{ fileName: "research-notes.md", id: "attachment-1", kind: "document" }]}
        controls={<button type="button">Model Fake QSA</button>}
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        value="Summarize these notes"
      />
    );

    const form = screen.getByTestId("composer-form");
    const surface = screen.getByTestId("composer-drop-zone");
    const messageField = screen.getByTestId("composer-message-field");
    const controls = screen.getByTestId("composer-controls-slot");
    const textarea = screen.getByLabelText("Message");
    const messageLabel = screen.getByText("Message", { selector: "label" });
    const send = screen.getByRole("button", { name: "Send message" });

    expect(form).toContainElement(surface);
    expect(messageField).toContainElement(messageLabel);
    expect(messageField).toContainElement(textarea);
    expect(messageLabel).toHaveClass("max-sm:sr-only", "[@media(max-height:32rem)]:sr-only");
    expect(messageLabel).toHaveAttribute("for", "composer");
    expect(messageField).toHaveClass("bg-surface-thread", "focus-within:ring-2");
    expect(messageField).not.toHaveClass("[@media(max-height:32rem)]:!grid");
    expect(surface).not.toHaveClass("focus-within:ring-2");
    expect(surface).toContainElement(textarea);
    expect(surface).toContainElement(screen.getByRole("list", { name: "Attachments" }));
    expect(surface).toContainElement(controls);
    expect(surface).toContainElement(send);
    expect(form).toHaveClass("sm:pb-[max(.75rem,env(safe-area-inset-bottom))]");
    expect(form).toHaveClass("[@media(max-height:32rem)]:!pt-1");
    expect(controls).toHaveClass("[@media(max-height:32rem)]:!p-1.5");
    expect(textarea).toHaveClass("[@media(max-height:32rem)]:!min-h-11");
    expect(textarea).toHaveClass("[@media(max-height:32rem)]:!max-h-16");
    expect(textarea).toHaveClass("mt-0", "sm:mt-1");
    expect(screen.getByRole("list", { name: "Attachments" })).toHaveClass(
      "[@media(max-height:32rem)]:!flex-nowrap",
      "[@media(max-height:32rem)]:!overflow-x-auto"
    );
    expect(textarea).toHaveAttribute("placeholder", "Ask AIQSA…");
    expect(send).toHaveTextContent("Send");
    expect(send).toHaveClass(
      "h-touch",
      "min-w-[72px]",
      "sm:min-w-[92px]",
      "[@media(max-height:32rem)]:!min-w-[72px]"
    );
  });

  it("keeps context, attachment, and Send in one compact action footer", () => {
    render(
      <Composer
        attachments={[]}
        contextLine="Approx. input: ~21k / 817k safe input · 1.05m total context"
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        onUploadFiles={() => undefined}
        value="Ready"
      />
    );

    const footer = screen.getByTestId("composer-action-footer");
    const context = screen.getByTestId("current-context-length");
    expect(footer).toHaveClass("grid-cols-[minmax(0,1fr)_auto]", "items-center");
    expect(footer).toContainElement(context);
    expect(footer).toContainElement(screen.getByLabelText("Attach file").closest("label"));
    expect(footer).toContainElement(screen.getByRole("button", { name: "Send message" }));
    expect(context).toHaveTextContent("~21k / 817k safe input · 1.05m total context");
    expect(context).toHaveAccessibleName("Approx. input: ~21k / 817k safe input · 1.05m total context");
  });

  it("keeps only the Message plane exposed while compact reading controls are collapsed", () => {
    const onRequestExpanded = vi.fn();
    render(
      <Composer
        attachments={[]}
        compactProfileControls={<button type="button">Fast</button>}
        contextLine="Approx. input: ~21k / 817k safe input · 1.05m total context"
        controls={<button type="button">Run setup</button>}
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onRequestExpanded={onRequestExpanded}
        onSend={() => undefined}
        readingCollapsed
        value=""
      />
    );

    expect(screen.getByTestId("composer-form")).toHaveAttribute(
      "data-reading-collapsed",
      "true"
    );
    expect(screen.getByTestId("composer-message-field")).toHaveClass(
      "mb-2",
      "grid",
      "grid-cols-[minmax(0,1fr)_auto]"
    );
    for (const disclosure of [
      screen.getByTestId("composer-controls-disclosure"),
      screen.getByTestId("composer-actions-disclosure")
    ]) {
      expect(disclosure).toHaveAttribute("aria-hidden", "true");
      expect(disclosure).toHaveAttribute("inert");
      expect(disclosure).toHaveClass(
        "grid-rows-[0fr]",
        "opacity-0",
        "transition-[grid-template-rows,opacity]",
        "motion-reduce:transition-none"
      );
    }
    expect(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
    expect(screen.getByTestId("composer-action-footer").querySelector('button[type="submit"]')).not.toBeNull();

    const message = screen.getByRole("textbox", { name: "Message" });
    fireEvent.pointerDown(message);
    fireEvent.focus(message);
    expect(onRequestExpanded).not.toHaveBeenCalled();
    fireEvent.click(message);
    expect(onRequestExpanded).toHaveBeenCalledOnce();

    fireEvent.blur(message);
    fireEvent.focus(message);
    expect(onRequestExpanded).toHaveBeenCalledTimes(2);
  });

  it("keeps a labeled Stop action beside Message in collapsed streaming reading mode", () => {
    const onRequestExpanded = vi.fn();
    const onStop = vi.fn();
    render(
      <Composer
        attachments={[]}
        contextLine="Approx. input: ~21k / 817k safe input · 1.05m total context"
        controls={<button type="button">Run setup</button>}
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onRequestExpanded={onRequestExpanded}
        onSend={() => undefined}
        onStop={onStop}
        readingCollapsed
        streaming
        value=""
      />
    );

    const stop = screen.getByTestId("composer-reading-stop");
    expect(stop).toHaveAccessibleName("Stop response");
    expect(stop).toHaveTextContent("Stop");
    expect(stop).toHaveClass("h-touch", "min-w-[72px]");
    fireEvent.focus(stop);
    fireEvent.pointerDown(stop);
    fireEvent.click(stop);
    expect(onRequestExpanded).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
  });

  it("sends on Enter and keeps Shift+Enter for new lines", () => {
    const onSend = vi.fn();
    const onChange = vi.fn();

    render(
      <Composer
        attachments={[]}
        onChange={onChange}
        onRemoveAttachment={() => undefined}
        onSend={onSend}
        value="Hello"
      />
    );

    const textarea = screen.getByLabelText("Message");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("does not send while the user is composing with an IME", () => {
    const onSend = vi.fn();

    render(
      <Composer
        attachments={[]}
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={onSend}
        value="konnichi"
      />
    );

    const textarea = screen.getByLabelText("Message");
    fireEvent.keyDown(textarea, { isComposing: true, key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Process" });
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("disables send when empty or streaming", () => {
    const { rerender } = render(
      <Composer
        attachments={[]}
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        value=""
      />
    );

    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    rerender(
      <Composer
        attachments={[]}
        disabled
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        value="Ready"
      />
    );

    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("associates disabled explanations with both the textarea and Send action", () => {
    render(
      <Composer
        attachments={[]}
        disabled
        disabledHint="No model is available for this account."
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        value="Ready"
      />
    );

    const hint = screen.getByTestId("composer-disabled-hint");
    const textarea = screen.getByLabelText("Message");
    const send = screen.getByRole("button", { name: "Send message" });
    const attachment = screen.getByLabelText("Attach file");
    const attachmentControl = attachment.closest("label");

    expect(hint).toHaveAttribute("role", "status");
    expect(hint).toHaveTextContent("No model is available for this account.");
    expect(textarea).toHaveAccessibleDescription("No model is available for this account.");
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription("No model is available for this account.");
    expect(attachment).toBeDisabled();
    expect(attachment).toHaveAccessibleDescription("No model is available for this account.");
    expect(attachmentControl).toHaveAttribute("aria-disabled", "true");
    expect(attachmentControl).toHaveAttribute("data-disabled", "true");
    expect(attachmentControl).toHaveClass("cursor-not-allowed", "text-content-disabled", "opacity-60");
    expect(attachmentControl).toHaveAttribute("title", "No model is available for this account.");
  });

  it("keeps drafting enabled while send is separately disabled", () => {
    const onChange = vi.fn();
    const onSend = vi.fn();

    render(
      <Composer
        attachments={[]}
        onChange={onChange}
        onRemoveAttachment={() => undefined}
        onSend={onSend}
        sendDisabled
        value="Next draft"
      />
    );

    const textarea = screen.getByLabelText("Message");
    expect(textarea).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "Next draft edited" } });
    expect(onChange).toHaveBeenCalledWith("Next draft edited");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("blocks submit while files are uploading", () => {
    const onSend = vi.fn();

    render(
      <Composer
        attachments={[]}
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={onSend}
        uploading
        value="Send after upload"
      />
    );

    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription("Uploading…");
    expect(screen.getByRole("status")).toHaveTextContent("Uploading…");
    expect(screen.getByTestId("composer-drop-zone")).toHaveAttribute("aria-busy", "true");
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("allows sending staged attachments without text", () => {
    const onSend = vi.fn();

    render(
      <Composer
        attachments={[{ fileName: "notes.md", id: "attachment-1", kind: "document" }]}
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={onSend}
        value=""
      />
    );

    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("requires edited text even with attachments and exposes cancel and remove actions", () => {
    const onCancelEdit = vi.fn();
    const onRemoveAttachment = vi.fn();
    const onSend = vi.fn();

    render(
      <Composer
        attachments={[{ fileName: "branch-source.pdf", id: "attachment-1", kind: "pdf" }]}
        editing
        onCancelEdit={onCancelEdit}
        onChange={() => undefined}
        onRemoveAttachment={onRemoveAttachment}
        onSend={onSend}
        value=""
      />
    );

    expect(screen.getByTestId("edit-branch-strip")).toHaveTextContent(
      "Editing a message — Send creates a new branch"
    );
    expect(screen.getByTestId("edit-branch-strip")).toHaveClass("[@media(max-height:32rem)]:!py-0");
    expect(screen.getByRole("list", { name: "Attachments" })).toBeVisible();
    expect(screen.getByTestId("attachment-chip")).toHaveAttribute("title", "branch-source.pdf");

    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove branch-source.pdf" }));
    expect(onRemoveAttachment).toHaveBeenCalledWith("attachment-1");

    fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
    expect(onCancelEdit).toHaveBeenCalledOnce();
  });

  it("disables repeated submit and Cancel only while an edited branch is pending", () => {
    const onCancelEdit = vi.fn();
    const onSend = vi.fn();
    const view = render(
      <Composer
        attachments={[]}
        editing
        editPending
        onCancelEdit={onCancelEdit}
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={onSend}
        value="Edited question"
      />
    );

    const textarea = screen.getByLabelText("Message");
    const cancel = screen.getByRole("button", { name: "Cancel edit" });
    const send = screen.getByRole("button", { name: "Send message" });
    expect(textarea).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Saving edited branch…");
    expect(cancel).toBeDisabled();
    expect(cancel).toHaveAccessibleDescription("Saving edited branch…");
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription("Saving edited branch…");
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.click(send);
    fireEvent.click(cancel);
    expect(onSend).not.toHaveBeenCalled();
    expect(onCancelEdit).not.toHaveBeenCalled();

    view.rerender(
      <Composer
        attachments={[]}
        editing
        onCancelEdit={onCancelEdit}
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={onSend}
        value="Edited question"
      />
    );
    expect(screen.getByRole("button", { name: "Cancel edit" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });

  it("allows selecting multiple attachments at once", () => {
    render(
      <Composer
        attachments={[]}
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        onUploadFiles={() => undefined}
        value=""
      />
    );

    const attachment = screen.getByLabelText("Attach file");
    expect(attachment).toBeEnabled();
    expect(attachment.closest("label")).not.toHaveAttribute("data-disabled");
    expect(attachment).toHaveAttribute("multiple");
    expect(attachment).toHaveAttribute(
      "accept",
      ".txt,.md,.markdown,.csv,.json,.html,.htm,text/plain,text/markdown,text/csv,application/json,text/html,application/pdf,image/png,image/jpeg,image/webp,image/gif"
    );
  });

  it("uploads files dropped on the composer and clears the drag-active state", () => {
    const onUploadFiles = vi.fn();
    const pdf = new File(["pdf"], "document.pdf", { type: "application/pdf" });
    const image = new File(["image"], "image.png", { type: "image/png" });
    const document = new File(["# notes"], "notes.md", { type: "text/plain" });
    const transfer = fileTransfer([pdf, image, document]);

    render(
      <Composer
        attachments={[]}
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        onUploadFiles={onUploadFiles}
        value=""
      />
    );

    const dropZone = screen.getByTestId("composer-drop-zone");

    fireEvent.dragEnter(dropZone, { dataTransfer: transfer });
    expect(dropZone).toHaveAttribute("data-drop-active", "true");
    fireEvent.dragOver(dropZone, { dataTransfer: transfer });
    expect(transfer.dropEffect).toBe("copy");
    fireEvent.drop(dropZone, { dataTransfer: transfer });

    expect(onUploadFiles).toHaveBeenCalledWith([pdf, image, document]);
    expect(dropZone).not.toHaveAttribute("data-drop-active");
  });

  it("clears the drag-active state on file drag leave", () => {
    const transfer = fileTransfer([new File(["pdf"], "document.pdf", { type: "application/pdf" })]);

    render(
      <Composer
        attachments={[]}
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        onUploadFiles={() => undefined}
        value=""
      />
    );

    const dropZone = screen.getByTestId("composer-drop-zone");

    fireEvent.dragEnter(dropZone, { dataTransfer: transfer });
    expect(dropZone).toHaveAttribute("data-drop-active", "true");
    fireEvent.dragLeave(dropZone, { dataTransfer: transfer });
    expect(dropZone).not.toHaveAttribute("data-drop-active");
  });

  it("filters picker and drop uploads through the selected-model attachment policy", () => {
    const callOrder: string[] = [];
    const onRejectedFiles = vi.fn();
    const onUploadFiles = vi.fn();
    const pdf = new File(["pdf"], "document.pdf", { type: "application/pdf" });
    const image = new File(["image"], "image.png", { type: "image/png" });
    const document = new File(["notes"], "notes.md", { type: "text/markdown" });
    const transfer = fileTransfer([pdf, image, document]);

    render(
      <Composer
        attachmentPolicy={{ documents: false, images: true, pdfs: false }}
        attachments={[]}
        onChange={() => undefined}
        onRejectedFiles={(files) => {
          callOrder.push("rejected");
          onRejectedFiles(files);
        }}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        onUploadFiles={(files) => {
          callOrder.push("upload");
          onUploadFiles(files);
        }}
        value=""
      />
    );

    expect(screen.getByLabelText("Attach file")).toHaveAttribute(
      "accept",
      "image/png,image/jpeg,image/webp,image/gif"
    );
    fireEvent.drop(screen.getByTestId("composer-drop-zone"), { dataTransfer: transfer });

    expect(onUploadFiles).toHaveBeenCalledWith([image]);
    expect(onRejectedFiles).toHaveBeenCalledWith([pdf, document]);
    expect(callOrder).toEqual(["upload", "rejected"]);
  });

  it("reports an all-rejected selection without starting an upload", () => {
    const onRejectedFiles = vi.fn();
    const onUploadFiles = vi.fn();
    const pdf = new File(["pdf"], "blocked.pdf", { type: "application/pdf" });

    render(
      <Composer
        attachmentPolicy={{ documents: false, images: true, pdfs: false }}
        attachments={[]}
        onChange={() => undefined}
        onRejectedFiles={onRejectedFiles}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        onUploadFiles={onUploadFiles}
        value=""
      />
    );

    fireEvent.drop(screen.getByTestId("composer-drop-zone"), {
      dataTransfer: fileTransfer([pdf])
    });

    expect(onRejectedFiles).toHaveBeenCalledWith([pdf]);
    expect(onUploadFiles).not.toHaveBeenCalled();
  });

  it("disables attachment entry when the selected model supports no attachment kinds", () => {
    render(
      <Composer
        attachmentPolicy={{ documents: false, images: false, pdfs: false }}
        attachments={[]}
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        onUploadFiles={() => undefined}
        value=""
      />
    );

    const input = screen.getByLabelText("Attach file");
    expect(input).toBeDisabled();
    expect(input).toHaveAccessibleDescription(
      "The selected model does not support file attachments."
    );
  });

  it.each([
    ["disabled", { disabled: true }],
    ["streaming", { streaming: true }],
    ["uploading", { uploading: true }]
  ])("prevents file drops while %s without starting upload", (_label, state) => {
    const onUploadFiles = vi.fn();
    const transfer = fileTransfer([new File(["pdf"], "document.pdf", { type: "application/pdf" })]);

    render(
      <Composer
        {...state}
        attachments={[]}
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        onUploadFiles={onUploadFiles}
        value=""
      />
    );

    const dropZone = screen.getByTestId("composer-drop-zone");

    fireEvent.dragEnter(dropZone, { dataTransfer: transfer });
    expect(dropZone).toHaveAttribute("data-drop-active", "true");
    fireEvent.dragOver(dropZone, { dataTransfer: transfer });
    expect(transfer.dropEffect).toBe("none");
    fireEvent.drop(dropZone, { dataTransfer: transfer });

    expect(onUploadFiles).not.toHaveBeenCalled();
    expect(dropZone).not.toHaveAttribute("data-drop-active");
  });

  it("does not intercept non-file drops", () => {
    const onUploadFiles = vi.fn();
    const transfer = fileTransfer([], ["text/plain"]);

    render(
      <Composer
        attachments={[]}
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        onUploadFiles={onUploadFiles}
        value=""
      />
    );

    const dropZone = screen.getByTestId("composer-drop-zone");

    expect(fireEvent.drop(dropZone, { dataTransfer: transfer })).toBe(true);
    expect(onUploadFiles).not.toHaveBeenCalled();
    expect(dropZone).not.toHaveAttribute("data-drop-active");
  });

  it("keeps wider context inline and moves compact context into touch-safe statistics", async () => {
    render(
      <Composer
        attachments={[]}
        compactProfileControls={
          <div role="group" aria-label="Run profile">
            <button type="button">Fast</button>
            <button type="button">Balanced</button>
            <button type="button">Deep</button>
          </div>
        }
        contextLine="Approx. input: ~121.9k / 232k safe input · 400k total context"
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        usageStats={{
          activeBranchMessageCount: 6,
          cachedInputTokens: 1200,
          cacheWriteInputTokens: 20,
          totalTokens: 4242
        }}
        value=""
      />
    );

    expect(screen.getByTestId("current-context-length")).toHaveTextContent(
      "~121.9k / 232k safe input · 400k total context"
    );
    expect(screen.getByTestId("current-context-length")).toHaveAccessibleName(
      "Approx. input: ~121.9k / 232k safe input · 400k total context"
    );
    expect(screen.getByTestId("current-context-length")).toHaveClass(
      "max-sm:hidden",
      "[@media(max-height:32rem)]:!hidden"
    );
    expect(screen.getByRole("group", { name: "Run profile" })).toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Open context and usage statistics" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Context and usage statistics" });
    expect(dialog).toBeVisible();
    expect(dialog).toHaveClass(
      "overflow-y-auto",
      "overscroll-contain",
      "[@media(max-height:32rem)]:fixed",
      "[@media(max-height:32rem)]:!right-[max(.5rem,env(safe-area-inset-right))]"
    );
    expect(screen.getByText("Current context")).toBeVisible();
    expect(dialog).toHaveTextContent("Approx. input: ~121.9k / 232k safe input · 400k total context");
    expect(screen.getByText("Total messages")).toBeVisible();
    expect(screen.getByText("6")).toBeVisible();
    expect(screen.getByText("Provider-reported tokens")).toBeVisible();
    expect(screen.getByText("4.2k")).toBeVisible();
    expect(screen.getByText("Total tokens cached")).toBeVisible();
    expect(screen.getByText("1.2k")).toBeVisible();
    expect(screen.queryByText(/cost/i)).not.toBeInTheDocument();

    const close = screen.getByRole("button", { name: "Close context and usage statistics" });
    expect(close).toHaveClass(
      "size-11",
      "[@media(hover:none)]:!size-11",
      "[@media(pointer:coarse)]:!size-11"
    );
    fireEvent.click(close);
    expect(dialog).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("restores context-statistics focus after an outside pointer close loses its control", async () => {
    render(
      <Composer
        attachments={[]}
        contextLine="Approx. input: ~2k / 115.2k safe input · 128k total context"
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        value=""
      />
    );

    const trigger = screen.getByRole("button", { name: "Open context and usage statistics" });
    fireEvent.click(trigger);
    const close = screen.getByRole("button", { name: "Close context and usage statistics" });
    close.focus();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("dialog", { name: "Context and usage statistics" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("shows a stop control while streaming", () => {
    const onStop = vi.fn();

    render(
      <Composer
        attachments={[]}
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        onStop={onStop}
        streaming
        value="Wait"
      />
    );

    const stop = screen.getByRole("button", { name: "Stop response" });
    expect(stop).toHaveTextContent("Stop");
    expect(stop).toHaveClass(
      "h-touch",
      "min-w-[72px]",
      "sm:min-w-[92px]",
      "[@media(max-height:32rem)]:!min-w-[72px]"
    );
    expect(screen.getByLabelText("Message")).toBeEnabled();
    const attachment = screen.getByLabelText("Attach file");
    expect(attachment).toBeDisabled();
    expect(attachment).toHaveAccessibleDescription(
      "Attachments are unavailable while a response is streaming."
    );
    expect(attachment.closest("label")).toHaveClass("cursor-not-allowed", "opacity-60");
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  });

  it("can keep the stop control disabled until cancellation is addressable", () => {
    const onStop = vi.fn();

    render(
      <Composer
        attachments={[]}
        onChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        onStop={onStop}
        stopDisabled
        streaming
        value="Wait"
      />
    );

    const stop = screen.getByRole("button", { name: "Stop response" });
    expect(stop).toBeDisabled();
    expect(stop).toHaveTextContent("Stop");
    expect(stop).toHaveAccessibleDescription("Starting run…");
    expect(screen.getByRole("status")).toHaveTextContent("Starting run…");
    fireEvent.click(stop);
    expect(onStop).not.toHaveBeenCalled();
  });
});
