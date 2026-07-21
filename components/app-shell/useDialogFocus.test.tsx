import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDialogFocus } from "./useDialogFocus";

type TestDialogProps = {
  active?: boolean;
  autoFocus?: boolean;
  closeOnEscape?: boolean;
  containFocus?: boolean;
  onClose(): void;
};

function TestDialog({ active, autoFocus, closeOnEscape, containFocus, onClose }: TestDialogProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>({
    active,
    autoFocus,
    closeOnEscape,
    containFocus,
    onClose
  });

  return (
    <div ref={dialogRef} role="dialog" aria-label="Test dialog">
      <button type="button">First action</button>
      <button type="button">Last action</button>
    </div>
  );
}

function NestedDialogs({
  childContainFocus = true,
  onChildClose,
  onParentClose
}: {
  childContainFocus?: boolean;
  onChildClose(): void;
  onParentClose(): void;
}) {
  const parentRef = useDialogFocus<HTMLDivElement>({
    autoFocus: false,
    onClose: onParentClose
  });
  const childRef = useDialogFocus<HTMLDivElement>({
    autoFocus: false,
    containFocus: childContainFocus,
    onClose: onChildClose
  });

  return (
    <div ref={parentRef} role="dialog" aria-label="Parent dialog">
      <button type="button">Parent action</button>
      <div ref={childRef} role="dialog" aria-label="Child dialog">
        <button type="button">First child action</button>
        <button type="button">Last child action</button>
      </div>
    </div>
  );
}

function createTrigger() {
  const trigger = document.createElement("button");
  trigger.dataset.dialogTestTrigger = "true";
  trigger.textContent = "Open dialog";
  document.body.appendChild(trigger);
  trigger.focus();
  return trigger;
}

describe("useDialogFocus", () => {
  afterEach(() => {
    document.querySelectorAll("[data-dialog-test-trigger]").forEach((trigger) => trigger.remove());
  });

  it("autofocuses, traps Tab, and restores focus with the default options", async () => {
    const trigger = createTrigger();

    const view = render(<TestDialog onClose={vi.fn()} />);
    const first = screen.getByRole("button", { name: "First action" });
    const last = screen.getByRole("button", { name: "Last action" });

    await waitFor(() => expect(first).toHaveFocus());

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();

    view.unmount();
    expect(trigger).toHaveFocus();
  });

  it("closes on Escape by default", async () => {
    createTrigger();
    const onClose = vi.fn();
    render(<TestDialog onClose={onClose} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "First action" })).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close when an inner control already owns Escape", async () => {
    const onClose = vi.fn();

    function DialogWithInlineEscapeOwner() {
      const dialogRef = useDialogFocus<HTMLDivElement>({ onClose });
      return (
        <div ref={dialogRef} role="dialog" aria-label="Inline editor dialog">
          <input
            aria-label="Inline name"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
              }
            }}
          />
        </div>
      );
    }

    render(<DialogWithInlineEscapeOwner />);
    const input = screen.getByRole("textbox", { name: "Inline name" });
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
  });

  it("lets the innermost dialog own Escape", () => {
    const onChildClose = vi.fn();
    const onParentClose = vi.fn();
    render(<NestedDialogs onChildClose={onChildClose} onParentClose={onParentClose} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "First child action" }), { key: "Escape" });

    expect(onChildClose).toHaveBeenCalledOnce();
    expect(onParentClose).not.toHaveBeenCalled();
  });

  it("lets the innermost dialog contain Tab without the parent taking focus", () => {
    render(<NestedDialogs onChildClose={vi.fn()} onParentClose={vi.fn()} />);
    const firstChildAction = screen.getByRole("button", { name: "First child action" });
    const lastChildAction = screen.getByRole("button", { name: "Last child action" });

    lastChildAction.focus();
    fireEvent.keyDown(lastChildAction, { key: "Tab" });
    expect(firstChildAction).toHaveFocus();

    fireEvent.keyDown(firstChildAction, { key: "Tab", shiftKey: true });
    expect(lastChildAction).toHaveFocus();
    expect(screen.getByRole("button", { name: "Parent action" })).not.toHaveFocus();
  });

  it("does not let a parent trap Tab on behalf of a non-containing child dialog", () => {
    render(
      <NestedDialogs
        childContainFocus={false}
        onChildClose={vi.fn()}
        onParentClose={vi.fn()}
      />
    );
    const lastChildAction = screen.getByRole("button", { name: "Last child action" });

    lastChildAction.focus();
    expect(fireEvent.keyDown(lastChildAction, { key: "Tab" })).toBe(true);
    expect(lastChildAction).toHaveFocus();
    expect(screen.getByRole("button", { name: "Parent action" })).not.toHaveFocus();
  });

  it("does not autofocus, trap Tab, or close on Escape while inactive", async () => {
    const trigger = createTrigger();
    const onClose = vi.fn();
    render(<TestDialog active={false} onClose={onClose} />);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const last = screen.getByRole("button", { name: "Last action" });
    expect(trigger).toHaveFocus();
    last.focus();
    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(true);
    expect(last).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("releases containment without restoring early, then restores when the active session ends", async () => {
    const trigger = createTrigger();
    const onClose = vi.fn();
    const view = render(
      <TestDialog active autoFocus closeOnEscape containFocus onClose={onClose} />
    );
    const first = screen.getByRole("button", { name: "First action" });

    await waitFor(() => expect(first).toHaveFocus());

    view.rerender(
      <TestDialog
        active
        autoFocus={false}
        closeOnEscape={false}
        containFocus={false}
        onClose={onClose}
      />
    );

    expect(first).toHaveFocus();
    expect(trigger).not.toHaveFocus();
    expect(fireEvent.keyDown(document, { key: "Tab", shiftKey: true })).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    view.rerender(
      <TestDialog
        active={false}
        autoFocus={false}
        closeOnEscape={false}
        containFocus={false}
        onClose={onClose}
      />
    );

    expect(trigger).toHaveFocus();
  });

  it("does not try to restore an opener that is no longer connected", async () => {
    const trigger = createTrigger();
    const view = render(<TestDialog onClose={vi.fn()} />);
    const first = screen.getByRole("button", { name: "First action" });

    await waitFor(() => expect(first).toHaveFocus());
    trigger.remove();

    expect(() => view.unmount()).not.toThrow();
  });

  it("uses a visible fallback when responsive composition hides the opener", async () => {
    const trigger = createTrigger();
    const fallback = document.createElement("button");
    fallback.dataset.dialogTestTrigger = "true";
    fallback.textContent = "Desktop fallback";
    document.body.appendChild(fallback);

    function ResponsiveDialog() {
      const dialogRef = useDialogFocus<HTMLDivElement>({
        onClose: vi.fn(),
        restoreFocus: () => fallback
      });
      return (
        <div ref={dialogRef} role="dialog" aria-label="Responsive dialog">
          <button type="button">Responsive action</button>
        </div>
      );
    }

    const view = render(<ResponsiveDialog />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Responsive action" })).toHaveFocus());
    trigger.style.display = "none";

    view.unmount();

    expect(fallback).toHaveFocus();
  });

  it("uses a fallback when the opener remains mounted under an inert modal layer", async () => {
    const inertLayer = document.createElement("div");
    inertLayer.dataset.dialogTestTrigger = "true";
    const trigger = document.createElement("button");
    trigger.textContent = "Layered opener";
    inertLayer.appendChild(trigger);
    document.body.appendChild(inertLayer);
    const fallback = document.createElement("button");
    fallback.dataset.dialogTestTrigger = "true";
    fallback.textContent = "Durable fallback";
    document.body.appendChild(fallback);
    trigger.focus();

    function LayeredDialog() {
      const dialogRef = useDialogFocus<HTMLDivElement>({
        onClose: vi.fn(),
        restoreFocus: () => fallback
      });
      return (
        <div ref={dialogRef} role="dialog" aria-label="Layered dialog">
          <button type="button">Layered action</button>
        </div>
      );
    }

    const view = render(<LayeredDialog />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Layered action" })).toHaveFocus());
    inertLayer.setAttribute("inert", "");

    view.unmount();

    expect(fallback).toHaveFocus();
  });

  it("does not treat the document body as a successful focus-restoration target", async () => {
    const fallback = document.createElement("button");
    fallback.dataset.dialogTestTrigger = "true";
    fallback.textContent = "Body fallback";
    document.body.appendChild(fallback);
    document.body.tabIndex = -1;
    document.body.focus();

    function BodyOpenedDialog() {
      const dialogRef = useDialogFocus<HTMLDivElement>({
        onClose: vi.fn(),
        restoreFocus: () => fallback
      });
      return (
        <div ref={dialogRef} role="dialog" aria-label="Body-opened dialog">
          <button type="button">Body-opened action</button>
        </div>
      );
    }

    const view = render(<BodyOpenedDialog />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Body-opened action" })).toHaveFocus());
    view.unmount();

    expect(fallback).toHaveFocus();
    document.body.removeAttribute("tabindex");
  });
});
