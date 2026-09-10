import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatImageV2 } from "./ChatImageV2";

describe("chat images", () => {
  it("opens an authenticated preview, restores keyboard focus and downloads without an edit button", async () => {
    render(<ChatImageV2 attachmentId="private-image" label="Blue circle" width={1024} height={1024} />);
    const opener = screen.getByRole("button", { name: "Open image: Blue circle" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Blue circle" });
    expect(screen.getByRole("button", { name: "Close image" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
    expect(dialog.querySelector("img")?.src).toContain("private-image/content?preview=image");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("download");
  });
});
