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
    // Signal surface: kind icon, text, close (coarse-pointer size lives in CSS).
    expect(screen.getByRole("alert")).toHaveAttribute("data-kind", "error");
    expect(screen.getByRole("alert").querySelector(".v2-notice-icon use")).toHaveAttribute("href", "#v2-icon-alert");
    expect(screen.getByRole("button", { name: "Dismiss notice" })).toHaveClass("v2-notice-close");
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

  it("auto-dismisses error notices that opt into the standard timeout", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();

    const view = render(
      <ShellNotice
        notice={{
          autoDismiss: true,
          kind: "error",
          text: "The complete thread could not be copied: clipboard denied"
        }}
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("could not be copied");
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onDismiss).toHaveBeenCalledOnce();

    // Errors without the opt-in keep waiting for the user.
    view.rerender(
      <ShellNotice notice={{ kind: "error", text: "Still failing" }} onDismiss={onDismiss} />
    );
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("keeps a public share link and its destructive revoke action available until dismissal", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const onCopy = vi.fn();
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
          secondaryAction: {
            label: "Copy link",
            onClick: onCopy,
            tone: "neutral"
          },
          text: "Share link copied"
        }}
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByRole("link", { name: "https://app.local/s/share" })).toHaveClass("v2-notice-link");
    expect(screen.getByRole("button", { name: "Revoke link" })).toHaveAttribute("data-tone", "destructive");
    expect(screen.getByRole("button", { name: "Copy link" })).toHaveAttribute("data-tone", "ghost");
    expect(screen.getByRole("status").querySelector(".v2-notice-icon use")).toHaveAttribute("href", "#v2-icon-check");
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(onCopy).toHaveBeenCalledOnce();
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

    expect(screen.getByRole("button", { name: "Retry" })).toHaveClass("v2-notice-action", "v2-button");
  });

  it("stays readable and blocks click-through without controls while a modal owns focus", () => {
    render(
      <ShellNotice
        interactive={false}
        notice={{
          action: { label: "Retry", onClick: vi.fn() },
          href: "https://app.local/s/share",
          kind: "error",
          secondaryAction: { label: "Copy link", onClick: vi.fn(), tone: "neutral" },
          text: "The modal action failed"
        }}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("The modal action failed");
    expect(screen.getByRole("alert")).toHaveClass("v2-notice");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("https://app.local/s/share")).toBeVisible();
  });
});
