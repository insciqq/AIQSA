import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellNotice } from "./ShellNotice";

describe("ShellNotice", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces errors and lets the user dismiss them", () => {
    const onDismiss = vi.fn();

    render(<ShellNotice notice={{ kind: "error", text: "Something failed" }} onDismiss={onDismiss} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Something failed");
    expect(screen.getByRole("button", { name: "Dismiss notice" })).toHaveClass(
      "size-11",
      "[@media(pointer:coarse)]:!size-11"
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("auto-dismisses success notices after five seconds", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const notice = { kind: "success" as const, text: "Changes saved" };

    const view = render(
      <ShellNotice
        notice={notice}
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("Changes saved");

    view.rerender(
      <ShellNotice
        notice={notice}
        onDismiss={() => onDismiss()}
      />
    );

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("keeps a public share link and its destructive revoke action available until dismissal", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const onRevoke = vi.fn();

    render(
      <ShellNotice
        notice={{
          action: {
            label: "Revoke link",
            onClick: onRevoke,
            tone: "destructive"
          },
          href: "https://app.local/s/share",
          kind: "success",
          persistent: true,
          text: "Share link copied"
        }}
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByRole("link", { name: "https://app.local/s/share" })).toHaveClass("min-h-touch");
    expect(screen.getByRole("button", { name: "Revoke link" })).toHaveClass(
      "rounded-control",
      "text-accent-rose"
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke link" }));
    expect(onRevoke).toHaveBeenCalledOnce();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("keeps optional recovery actions touch-safe", () => {
    render(
      <ShellNotice
        notice={{
          action: { label: "Retry", onClick: vi.fn() },
          kind: "error",
          text: "The action failed"
        }}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Retry" })).toHaveClass(
      "min-h-touch",
      "[@media(hover:none)]:!min-h-touch"
    );
  });

  it("stays readable and blocks click-through without controls while a modal owns focus", () => {
    render(
      <ShellNotice
        interactive={false}
        notice={{
          action: { label: "Retry", onClick: vi.fn() },
          href: "https://app.local/s/share",
          kind: "error",
          text: "The modal action failed"
        }}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("The modal action failed");
    expect(screen.getByRole("alert")).toHaveClass("pointer-events-auto");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("https://app.local/s/share")).toBeVisible();
  });
});
