/**
 * The bounds of the image previews one request carries with its tool results (`view_workspace_image`,
 * `read_chat_file`, `computer_read`). A leaf: the viewer (`directImageView.ts`) and the shared request room
 * (`lib/server/tools/requestImageAllowance.ts`) both read it, so neither imports the other.
 */
export const DIRECT_IMAGE_VIEW_LIMITS = Object.freeze({
  /** Bytes of one preview: under Anthropic's 5 MB per image once base64-encoded. */
  imageBytes: 3 * 1024 * 1024,
  /** Pixels of one preview: the largest resize the tool takes (2048×2048). */
  imagePixels: 2048 * 2048,
  /** Base64 bytes of the previews one request carries, well inside every route's request size limit. */
  requestBytes: 12 * 1024 * 1024,
  /** Previews one request carries (`viewWorkspaceImageTool`'s description says so). */
  requestImages: 8,
  /** Share of the model's context window the previews of one request may take. */
  windowShare: 0.25
});
