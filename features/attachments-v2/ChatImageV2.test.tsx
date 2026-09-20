import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("attaches once while pending and allows retry after a failed attachment", async () => {
    let rejectAttachment!: (error: Error) => void;
    const onUseInArtifact = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectAttachment = reject; }))
      .mockResolvedValue(undefined);
    render(<ChatImageV2 attachmentId="generated-image" label="Generated" onUseInArtifact={onUseInArtifact} />);
    fireEvent.click(screen.getByRole("button", { name: "Use in artifact" }));
    const pending = screen.getByRole("button", { name: "Attaching…" });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(onUseInArtifact).toHaveBeenCalledOnce();
    rejectAttachment(new Error("attachment_unavailable"));
    expect(await screen.findByRole("status")).toHaveTextContent("Could not attach this image");
    fireEvent.click(screen.getByRole("button", { name: "Use in artifact" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Use in artifact" })).toBeEnabled());
    expect(onUseInArtifact).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
