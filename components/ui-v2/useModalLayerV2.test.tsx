import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModalLayerV2 } from "./useModalLayerV2";

function PersistentLayer({ enabled, onClose }: { enabled: boolean; onClose(): void }) {
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({ enabled, onClose });
  return portalReady ? createPortal(<div><section aria-label="Preview" aria-modal={enabled || undefined}
    onKeyDown={onDialogKeyDown} ref={dialogRef} role={enabled ? "dialog" : "region"}>
    <button ref={initialFocusRef}>Close preview</button><button>Last action</button>
  </section></div>, document.body) : null;
}

describe("persistent modal layers", () => {
  it("activates focus and inert isolation only when enabled, then restores the current opener on each activation", async () => {
    const opener = document.createElement("button");
    const nextOpener = document.createElement("button");
    document.body.append(opener, nextOpener);
    opener.focus();
    const onClose = vi.fn();
    const { rerender, unmount } = render(<PersistentLayer enabled={false} onClose={onClose} />);
    const button = screen.getByRole("button", { name: "Close preview" });
    expect(opener).toHaveFocus();
    expect(opener.inert).not.toBe(true);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    rerender(<PersistentLayer enabled onClose={onClose} />);
    expect(button).toHaveFocus();
    expect(opener.inert).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(button, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Last action" })).toHaveFocus();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    rerender(<PersistentLayer enabled={false} onClose={onClose} />);
    await waitFor(() => expect(opener).toHaveFocus());
    expect(opener.inert).not.toBe(true);
    expect(document.body.style.overflow).toBe("");
    expect(screen.getByRole("button", { name: "Close preview" })).toBe(button);
    nextOpener.focus();
    rerender(<PersistentLayer enabled onClose={onClose} />);
    unmount();
    await waitFor(() => expect(nextOpener).toHaveFocus());
    expect(nextOpener.inert).not.toBe(true);
    opener.remove(); nextOpener.remove();
  });
});

function Layer({ children, label }: { children?: ReactNode; label: string }) {
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({ onClose: () => undefined });
  return portalReady ? createPortal(<div data-testid={`${label} root`}><section aria-label={label} aria-modal="true"
    onKeyDown={onDialogKeyDown} ref={dialogRef} role="dialog">
    <button ref={initialFocusRef}>{`${label} first`}</button>{children}
  </section></div>, document.body) : null;
}

function NestedLayers({ child, parent }: { child: boolean; parent: boolean }) {
  return parent ? <Layer label="Sheet">{child ? <Layer label="Confirm" /> : null}</Layer> : null;
}

function SiblingLayers({ open }: { open: boolean }) {
  return open ? <><Layer label="Sheet" /><Layer label="Confirm" /></> : null;
}

function isolation(element: Element) {
  return { ariaHidden: element.getAttribute("aria-hidden"), inert: (element as HTMLElement).inert === true };
}

describe("stacked modal layers", () => {
  let main: HTMLElement;
  let opener: HTMLButtonElement;
  beforeEach(() => {
    main = document.createElement("main");
    opener = document.createElement("button");
    opener.textContent = "Open sheet";
    main.append(opener);
    document.body.append(main);
    opener.focus();
  });
  afterEach(() => {
    main.remove();
    document.body.style.overflow = "";
  });

  const pageRestored = async () => {
    await waitFor(() => expect(opener).toHaveFocus());
    expect(document.body.style.overflow).toBe("");
    for (const child of document.body.children) expect(isolation(child)).toEqual({ ariaHidden: null, inert: false });
  };

  it("keeps the page isolated while any layer remains and restores it after a parent-first unmount", async () => {
    const { rerender } = render(<NestedLayers child={false} parent />);
    rerender(<NestedLayers child parent />);
    expect(screen.getByRole("button", { name: "Confirm first" })).toHaveFocus();
    expect(isolation(main)).toEqual({ ariaHidden: "true", inert: true });
    expect(isolation(screen.getByTestId("Sheet root"))).toEqual({ ariaHidden: "true", inert: true });
    expect(isolation(screen.getByTestId("Confirm root"))).toEqual({ ariaHidden: null, inert: false });
    rerender(<NestedLayers child={false} parent={false} />);
    await pageRestored();
  });

  it("returns a closed child to its opener in the remaining layer, which stays modal until it closes", async () => {
    const { rerender } = render(<NestedLayers child={false} parent />);
    const sheetFirst = screen.getByRole("button", { name: "Sheet first" });
    rerender(<NestedLayers child parent />);
    rerender(<NestedLayers child={false} parent />);
    await waitFor(() => expect(sheetFirst).toHaveFocus());
    expect(isolation(main)).toEqual({ ariaHidden: "true", inert: true });
    expect(isolation(screen.getByTestId("Sheet root"))).toEqual({ ariaHidden: null, inert: false });
    expect(document.body.style.overflow).toBe("hidden");
    rerender(<NestedLayers child={false} parent={false} />);
    await pageRestored();
  });

  it("restores the page when sibling layers close in one commit", async () => {
    const { rerender } = render(<SiblingLayers open />);
    expect(screen.getByRole("button", { name: "Confirm first" })).toHaveFocus();
    expect(isolation(screen.getByTestId("Sheet root"))).toEqual({ ariaHidden: "true", inert: true });
    rerender(<SiblingLayers open={false} />);
    await pageRestored();
  });

  it("survives StrictMode effect replay without leaking isolation or stealing focus", async () => {
    const { rerender } = render(<StrictMode><NestedLayers child={false} parent /></StrictMode>);
    const sheetFirst = screen.getByRole("button", { name: "Sheet first" });
    await waitFor(() => expect(sheetFirst).toHaveFocus());
    rerender(<StrictMode><NestedLayers child parent /></StrictMode>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm first" })).toHaveFocus());
    expect(isolation(main)).toEqual({ ariaHidden: "true", inert: true });
    expect(isolation(screen.getByTestId("Confirm root"))).toEqual({ ariaHidden: null, inert: false });
    rerender(<StrictMode><NestedLayers child={false} parent={false} /></StrictMode>);
    await pageRestored();
  });

  it("restores pre-existing inert, aria-hidden and overflow values", async () => {
    main.inert = true;
    main.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "scroll";
    const { rerender } = render(<SiblingLayers open />);
    expect(isolation(main)).toEqual({ ariaHidden: "true", inert: true });
    expect(document.body.style.overflow).toBe("hidden");
    rerender(<SiblingLayers open={false} />);
    await waitFor(() => expect(document.body.style.overflow).toBe("scroll"));
    expect(isolation(main)).toEqual({ ariaHidden: "false", inert: true });
  });
});

function FallbackLayer({ fallback }: { fallback: HTMLElement }) {
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({
    onClose: () => undefined,
    restoreFocus: () => fallback
  });
  return portalReady ? createPortal(<div><section aria-label="Parameters" aria-modal="true"
    onKeyDown={onDialogKeyDown} ref={dialogRef} role="dialog">
    <button ref={initialFocusRef}>Close parameters</button>
  </section></div>, document.body) : null;
}

describe("a layer with a focus fallback", () => {
  let opener: HTMLButtonElement;
  let fallback: HTMLButtonElement;
  beforeEach(() => {
    opener = document.createElement("button");
    fallback = document.createElement("button");
    document.body.append(opener, fallback);
  });
  afterEach(() => {
    opener.remove();
    fallback.remove();
  });

  it("returns focus to its opener while that is still reachable", async () => {
    opener.focus();
    render(<FallbackLayer fallback={fallback} />).unmount();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  const changes: [string, (element: HTMLButtonElement) => void][] = [
    ["was removed", (element) => element.remove()],
    ["was disabled", (element) => { element.disabled = true; }],
    ["was the page itself", () => undefined]
  ];
  it.each(changes)("returns focus to the fallback when its opener %s", async (way, change) => {
    if (way === "was the page itself") (document.activeElement as HTMLElement | null)?.blur();
    else opener.focus();
    const { unmount } = render(<FallbackLayer fallback={fallback} />);
    expect(screen.getByRole("button", { name: "Close parameters" })).toHaveFocus();
    change(opener);
    unmount();
    await waitFor(() => expect(fallback).toHaveFocus());
  });
});

function EscapeLayer({ children, closeBlocked, enabled, label, onClose }: {
  children?: ReactNode; closeBlocked?: boolean; enabled?: boolean; label: string; onClose(): void;
}) {
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({ closeBlocked, enabled, onClose });
  return portalReady ? createPortal(<div data-testid={`${label} root`}><section aria-label={label} aria-modal="true"
    onKeyDown={onDialogKeyDown} ref={dialogRef} role="dialog">
    <button ref={initialFocusRef}>{`${label} first`}</button><p>{`${label} picture`}</p>{children}
  </section></div>, document.body) : null;
}

describe("Escape after focus left the dialog", () => {
  let main: HTMLElement;
  let opener: HTMLButtonElement;
  beforeEach(() => {
    main = document.createElement("main");
    opener = document.createElement("button");
    main.append(opener);
    document.body.append(main);
    opener.focus();
  });
  afterEach(() => {
    main.remove();
    document.body.style.overflow = "";
  });

  const leaveFocus = () => (document.activeElement as HTMLElement | null)?.blur();
  const escape = (target: Element = document.body, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(target, { key: "Escape", ...init });

  it("closes the layer once from the page, and once from its own dialog, never twice", () => {
    const onClose = vi.fn();
    render(<EscapeLayer label="Viewer" onClose={onClose} />);
    leaveFocus();
    expect(document.body).toHaveFocus();
    expect(escape()).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    escape(screen.getByTestId("Viewer root"));
    expect(onClose).toHaveBeenCalledTimes(2);
    // Focus left on the isolated page behind belongs to the layer too.
    escape(opener);
    expect(onClose).toHaveBeenCalledTimes(3);
    escape(screen.getByRole("button", { name: "Viewer first" }));
    expect(onClose).toHaveBeenCalledTimes(4);
    escape(screen.getByText("Viewer picture"));
    expect(onClose).toHaveBeenCalledTimes(5);
  });

  it("ignores other keys, handled Escapes, IME composition and a blocked close", () => {
    const onClose = vi.fn();
    const { rerender } = render(<EscapeLayer label="Viewer" onClose={onClose} />);
    leaveFocus();
    fireEvent.keyDown(document.body, { key: "Enter" });
    escape(document.body, { isComposing: true });
    escape(screen.getByRole("button", { name: "Viewer first" }), { isComposing: true });
    const handled = (event: Event) => event.preventDefault();
    document.body.addEventListener("keydown", handled);
    escape();
    document.body.removeEventListener("keydown", handled);
    rerender(<EscapeLayer closeBlocked label="Viewer" onClose={onClose} />);
    expect(escape()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    rerender(<EscapeLayer label="Viewer" onClose={onClose} />);
    escape();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("lets only the innermost layer react, then the next one after it closes", async () => {
    const closeSheet = vi.fn();
    const closeConfirm = vi.fn();
    const Nested = ({ child }: { child: boolean }) => <EscapeLayer label="Sheet" onClose={closeSheet}>
      {child ? <EscapeLayer label="Confirm" onClose={closeConfirm} /> : null}
    </EscapeLayer>;
    // A nested confirmation opens from its sheet, after it.
    const { rerender } = render(<Nested child={false} />);
    rerender(<Nested child />);
    leaveFocus();
    escape();
    expect(closeConfirm).toHaveBeenCalledOnce();
    expect(closeSheet).not.toHaveBeenCalled();
    rerender(<Nested child={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Sheet first" })).toHaveFocus());
    leaveFocus();
    escape();
    expect(closeSheet).toHaveBeenCalledOnce();
    expect(closeConfirm).toHaveBeenCalledOnce();
  });

  it("stops listening when the layer is disabled or unmounted", async () => {
    const onClose = vi.fn();
    const { rerender, unmount } = render(<EscapeLayer label="Viewer" onClose={onClose} />);
    rerender(<EscapeLayer enabled={false} label="Viewer" onClose={onClose} />);
    await waitFor(() => expect(opener).toHaveFocus());
    leaveFocus();
    escape();
    opener.focus();
    rerender(<EscapeLayer label="Viewer" onClose={onClose} />);
    unmount();
    await waitFor(() => expect(opener).toHaveFocus());
    leaveFocus();
    escape();
    expect(onClose).not.toHaveBeenCalled();
  });
});
