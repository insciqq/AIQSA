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
  /** Base64 bytes of the previews one request carries; the input's own images count only against the totals below. */
  requestBytes: 12 * 1024 * 1024,
  /** Previews one request carries (`viewWorkspaceImageTool`'s description says so); the input's own images count only below. */
  requestImages: 8,
  /**
   * Base64 bytes of every image one request carries, the input's own and the previews together, when the model declares
   * no payload limit: under Anthropic's 32 MB request limit, the lowest of the native answer routes (Gemini takes 100 MB
   * inline), with room for the text.
   */
  requestTotalBytes: 24 * 1024 * 1024,
  /** Images one request carries, its own and the previews together, when the model declares no count: Anthropic's limit. */
  requestTotalImages: 100,
  /** Share of the model's context window the images of one request take at most, the input's own counted first. */
  windowShare: 0.25
});
