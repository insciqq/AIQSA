import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAnnouncementsSection } from "./AdminAnnouncementsSection";
import { AnnouncementRequestError, discardAnnouncement, getAnnouncement, listAnnouncements, saveAnnouncement } from "@/components/announcements/api";

vi.mock("@/components/announcements/api", async original => ({ ...await original<typeof import("@/components/announcements/api")>(),
  discardAnnouncement: vi.fn(), getAnnouncement: vi.fn(), listAnnouncements: vi.fn(), saveAnnouncement: vi.fn() }));
const entry = { id: "news-1", title: "Saved title", body: "Saved message", excerpt: "Saved message", version: 2, published: false,
  publishedAt: "2026-09-16T12:00:00.000Z", createdAt: "2026-09-15T12:00:00.000Z", read: true };
const save = vi.mocked(saveAnnouncement), get = vi.mocked(getAnnouncement), discard = vi.mocked(discardAnnouncement);
function fixture(resource = "new") {
  const onSelectResource = vi.fn();
  render(<AdminAnnouncementsSection resource={resource} onSelectResource={onSelectResource} />);
  return { onSelectResource };
}
beforeEach(() => {
  get.mockReset().mockResolvedValue(entry);
  save.mockReset().mockResolvedValue(entry);
  discard.mockReset().mockResolvedValue(true);
  vi.mocked(listAnnouncements).mockReset().mockResolvedValue({ items: [entry], nextCursor: null, unreadCount: 0 });
});

describe("announcement editor sheet", () => {
  it("opens a blank new editor after viewing an existing entry", async () => {
    const props = { onSelectResource: vi.fn() };
    const view = render(<AdminAnnouncementsSection {...props} resource={entry.id} />);
    await screen.findByRole("dialog", { name: "Edit announcement" });
    view.rerender(<AdminAnnouncementsSection {...props} resource={null} />);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    view.rerender(<AdminAnnouncementsSection {...props} resource="new" />);
    await screen.findByRole("dialog", { name: "New announcement" });
    expect(screen.getByLabelText("Title")).toHaveValue("");
    expect(screen.getByLabelText("Message")).toHaveValue("");
  });

  it("owns dirty close confirmation and blocks duplicate saves", async () => {
    const f = fixture();
    await screen.findByRole("dialog", { name: "New announcement" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My title" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "My unsaved message" } });
    fireEvent.keyDown(screen.getByRole("dialog", { name: "New announcement" }), { key: "Escape" });
    const confirmation = screen.getByRole("dialog", { name: "Unsaved announcement" });
    expect(confirmation).toBeVisible();
    expect(f.onSelectResource).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Message")).toHaveValue("My unsaved message");

    let resolve!: (value: typeof entry) => void;
    save.mockImplementationOnce(() => new Promise(settle => { resolve = settle; }));
    const button = screen.getByRole("button", { name: "Save draft" });
    fireEvent.click(button); fireEvent.click(button);
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    await act(async () => resolve({ ...entry, title: "My title", body: "My unsaved message" }));
    await waitFor(() => expect(f.onSelectResource).toHaveBeenCalledWith(entry.id));
  });

  it("publishes a new entry only after explicit confirmation", async () => {
    fixture();
    await screen.findByRole("dialog", { name: "New announcement" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "New release" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Release notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish to everyone" }));
    expect(save).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("dialog", { name: "Publish announcement" });
    expect(confirmation).toHaveTextContent("New release");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Confirm publish to everyone" }));
    expect(save).toHaveBeenCalledWith({ title: "New release", body: "Release notes" }, undefined, true);
  });

  it("preserves conflicted edits and reloads the saved revision after confirmation", async () => {
    fixture(entry.id);
    await screen.findByRole("dialog", { name: "Edit announcement" });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Unsaved text" } });
    save.mockRejectedValueOnce(new AnnouncementRequestError("announcement_conflict"));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("another session");
    expect(screen.getByLabelText("Message")).toHaveValue("Unsaved text");
    const latest = { ...entry, version: 7, body: "Latest saved text" };
    get.mockResolvedValueOnce(latest);
    fireEvent.click(screen.getByRole("button", { name: "Reload saved version" }));
    expect(screen.getByLabelText("Message")).toHaveValue("Unsaved text");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Reload announcement" })).getByRole("button", { name: "Confirm reload" }));
    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue("Latest saved text"));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ title: entry.title, body: "Latest saved text" }, { id: entry.id, version: 7, published: false }, false));
  });

  it("allows confirmed permanent deletion of a withdrawn entry", async () => {
    const f = fixture(entry.id);
    await screen.findByRole("dialog", { name: "Edit announcement" });
    fireEvent.click(screen.getByRole("button", { name: "Delete announcement" }));
    expect(discard).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("dialog", { name: "Delete announcement" });
    expect(confirmation).toHaveTextContent(entry.title);
    fireEvent.click(within(confirmation).getByRole("button", { name: "Confirm delete announcement" }));
    expect(discard).toHaveBeenCalledWith(entry.id, entry.version);
    await waitFor(() => expect(f.onSelectResource).toHaveBeenCalledWith(null));
  });
});
