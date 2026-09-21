import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createPortal } from "react-dom";
import { describe, expect, it, vi } from "vitest";
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
