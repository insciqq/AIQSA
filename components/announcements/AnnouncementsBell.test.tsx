import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnouncementsBell } from "./AnnouncementsBell";
import { AnnouncementsProvider, useAnnouncements } from "./AnnouncementsProvider";
import { AnnouncementRequestError, getAnnouncement, getAnnouncementUnreadCount, listAnnouncements, markAnnouncementsRead } from "./api";

vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(),
  getAnnouncement: vi.fn(), getAnnouncementUnreadCount: vi.fn(), listAnnouncements: vi.fn(), markAnnouncementsRead: vi.fn() }));
const count = vi.mocked(getAnnouncementUnreadCount), list = vi.mocked(listAnnouncements), detail = vi.mocked(getAnnouncement), read = vi.mocked(markAnnouncementsRead);
const item = { id: "news-1", title: "Release notes", excerpt: "A short message", publishedAt: "2026-09-16T12:00:00.000Z", read: false };
function Probe() {
  const owner = useAnnouncements()!;
  return <><output data-testid="shared-count">{owner.unreadCount}</output><button onClick={() => { void owner.markRead(null); }}>Read from another consumer</button></>;
}
function Fixture({ accountId = "account-a" }: Readonly<{ accountId?: string }>) {
  return <AnnouncementsProvider accountId={accountId}><AnnouncementsBell /><Probe /></AnnouncementsProvider>;
}
beforeEach(() => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  count.mockReset().mockResolvedValue(3);
  list.mockReset().mockResolvedValue({ items: [item], nextCursor: null, unreadCount: 99 });
  detail.mockReset().mockResolvedValue({ ...item, body: "Published body" });
  read.mockReset().mockResolvedValue(0);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function inbox() {
  const bell = await screen.findByRole("button", { name: "Announcements, 3 unread" });
  bell.focus(); fireEvent.click(bell);
  const dialog = await screen.findByRole("dialog", { name: "Announcements" });
  await within(dialog).findByRole("button", { name: /Release notes/u });
  return { bell, dialog };
}

describe("announcement inbox and account owner", () => {
  it("refreshes edits, removals and cross-device read state without losing loaded history", async () => {
    const older = { ...item, id: "news-2", title: "Earlier notes" };
    list.mockResolvedValueOnce({ items: [item], nextCursor: "cursor-1", unreadCount: 3 })
      .mockResolvedValueOnce({ items: [older], nextCursor: "cursor-2", unreadCount: 3 });
    render(<Fixture />);
    const { dialog } = await inbox();
    fireEvent.click(within(dialog).getByRole("button", { name: "Show earlier" }));
    await within(dialog).findByRole("button", { name: /Earlier notes/u });
    list.mockResolvedValueOnce({ items: [{ ...older, title: "Edited earlier notes", read: true }], nextCursor: "new-cursor", unreadCount: 0 })
      .mockResolvedValueOnce({ items: [{ ...item, id: "news-3", title: "Oldest notes", read: true }], nextCursor: null, unreadCount: 0 });
    count.mockResolvedValue(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh announcements" }));
    await within(dialog).findByRole("button", { name: /Oldest notes/u });
    expect(within(dialog).getByRole("button", { name: /Edited earlier notes/u })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: /Release notes/u })).toBeNull();
    expect(within(dialog).queryByText("(unread)")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Show earlier" })).toBeNull();
    expect(screen.getByTestId("shared-count")).toHaveTextContent("0");
  });

  it("shares the count, acknowledges only an opened entry, and restores focus", async () => {
    render(<Fixture />);
    const { bell, dialog } = await inbox();
    expect(within(dialog).getByText("3 unread")).toBeVisible();
    expect(within(dialog).queryByText("99 unread")).toBeNull();
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: /Release notes/u }));
    const heading = await within(dialog).findByRole("heading", { name: "Release notes" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(read).toHaveBeenCalledWith(item.id, expect.any(AbortSignal));
    await waitFor(() => expect(screen.getByTestId("shared-count")).toHaveTextContent("0"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Back to announcements" }));
    expect(within(dialog).getByRole("button", { name: /Release notes/u })).toHaveFocus();
    expect(within(dialog).queryByText("(unread)")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close announcements" }));
    await waitFor(() => expect(bell).toHaveFocus());
    expect(bell).toHaveAccessibleName("Announcements");
  });

  it("renders hostile Markdown safely at the announcement surface", async () => {
    detail.mockResolvedValue({ ...item, body: "![remote](https://example.com/image.png)\n<script>alert(1)</script>\n[unsafe](javascript:alert(1)) [external](https://example.com)" });
    render(<Fixture />);
    const { dialog } = await inbox();
    fireEvent.click(within(dialog).getByRole("button", { name: /Release notes/u }));
    const link = await within(dialog).findByRole("link", { name: "external" });
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
    expect(dialog.querySelector("img, script, a[href^='javascript:']")).toBeNull();
  });

  it("restores the list row after returning during a pending read acknowledgement", async () => {
    let resolve!: (count: number) => void;
    read.mockImplementationOnce(() => new Promise(settle => { resolve = settle; }));
    render(<Fixture />);
    const { dialog } = await inbox();
    fireEvent.click(within(dialog).getByRole("button", { name: /Release notes/u }));
    await within(dialog).findByRole("heading", { name: "Release notes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Back to announcements" }));
    const row = within(dialog).getByRole("button", { name: /Release notes/u });
    expect(row).toBeDisabled();
    await act(async () => resolve(0));
    expect(row).toBeEnabled();
    expect(row).toHaveFocus();
  });

  it("preserves a failed acknowledgement for an explicit retry", async () => {
    read.mockRejectedValueOnce(new AnnouncementRequestError("network_error"));
    render(<Fixture />);
    const { dialog } = await inbox();
    fireEvent.click(within(dialog).getByRole("button", { name: /Release notes/u }));
    await within(dialog).findByRole("alert");
    expect(within(dialog).getByText("Published body")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("shared-count")).toHaveTextContent("0"));
    expect(read).toHaveBeenCalledTimes(2);
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("ignores a stale count reply after a read mutation", async () => {
    let resolve!: (value: number) => void;
    count.mockImplementationOnce(() => new Promise(settle => { resolve = settle; }));
    render(<Fixture />);
    await waitFor(() => expect(count).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Read from another consumer" }));
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(count.mock.calls[0][0]?.aborted).toBe(true);
    await act(async () => resolve(7));
    expect(screen.getByTestId("shared-count")).toHaveTextContent("0");
  });

  it("drops the inbox and old responses when the account changes", async () => {
    const view = render(<Fixture />);
    await inbox();
    let resolve!: (value: number) => void;
    count.mockImplementationOnce(() => new Promise(settle => { resolve = settle; }));
    fireEvent.focus(window);
    await waitFor(() => expect(count).toHaveBeenCalledTimes(3));
    count.mockResolvedValue(1);
    view.rerender(<Fixture accountId="account-b" />);
    await screen.findByRole("button", { name: "Announcements, 1 unread" });
    await act(async () => resolve(99));
    expect(screen.queryByRole("dialog", { name: "Announcements" })).toBeNull();
    expect(screen.getByTestId("shared-count")).toHaveTextContent("1");
  });

  it("polls no faster than 30 seconds while visible and refreshes on focus", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const view = render(<Fixture />);
    await screen.findByRole("button", { name: "Announcements, 3 unread" });
    await act(() => vi.advanceTimersByTimeAsync(29_999));
    expect(count).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(count).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("hidden");
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(count).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("visible"); fireEvent.focus(window);
    await waitFor(() => expect(count).toHaveBeenCalledTimes(3));
    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(count).toHaveBeenCalledTimes(3);
  });
});
