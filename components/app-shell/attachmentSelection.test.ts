import { describe, expect, it } from "vitest";
import { DEFAULT_COMPOSER_ATTACHMENT_POLICY, partitionAttachmentSelection } from "./attachmentSelection";

const file = (name: string, type: string) => new File(["synthetic"], name, { type });
const names = (files: readonly File[]) => files.map((entry) => `${entry.name}|${entry.type}`);

describe("composer attachment selection", () => {
  it("accepts a static-raster name whose MIME names another raster as an ordinary image", () => {
    const selection = [
      file("synthetic.jpeg", "image/png"),
      file("synthetic.png", "image/jpeg"),
      file("synthetic.webp", "image/png"),
      file("synthetic.jpeg", "application/octet-stream"),
      file("synthetic.jpeg", "")
    ];

    const { accepted, rejected } = partitionAttachmentSelection(selection, DEFAULT_COMPOSER_ATTACHMENT_POLICY);

    expect(names(accepted)).toEqual(names(selection));
    expect(rejected).toEqual([]);
    // PowerAppShellV2 turns Workspace on only for files the ordinary policy rejects.
    expect(partitionAttachmentSelection([file("synthetic.jpeg", "image/png")], DEFAULT_COMPOSER_ATTACHMENT_POLICY).rejected)
      .toHaveLength(0);
  });

  it("keeps other mismatches and image-less models rejected", () => {
    const { accepted, rejected } = partitionAttachmentSelection([
      file("synthetic.jpeg", "image/svg+xml"),
      file("synthetic.jpeg", "image/gif"),
      file("synthetic.gif", "image/png"),
      file("synthetic.png", "text/plain"),
      file("synthetic", "image/png")
    ], DEFAULT_COMPOSER_ATTACHMENT_POLICY);
    expect(accepted).toEqual([]);
    expect(rejected).toHaveLength(5);

    const withoutImages = partitionAttachmentSelection([file("synthetic.jpeg", "image/png")], {
      ...DEFAULT_COMPOSER_ATTACHMENT_POLICY, images: false
    });
    expect(withoutImages.rejected).toHaveLength(1);
  });
});
