/**
 * uv's download and environment cache on the chat's own guest disk, so
 * `uv run --script` reuses it between runs of the same chat. It lies outside
 * every export, archive, share and carry-over root (`/workspace/output`,
 * `/workspace/project`, `/workspace/inbox`), so it never leaves the disk.
 */
export const WORKSPACE_UV_CACHE_DIRECTORY = "/workspace/.cache/uv";

/**
 * Release defaults every guest command starts from. Run, saved and
 * per-command values of the same name win.
 */
export const WORKSPACE_GUEST_COMMAND_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  UV_CACHE_DIR: WORKSPACE_UV_CACHE_DIRECTORY
});
