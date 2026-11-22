/**
 * A content-free failure of one background item. The code is registered in `failureCodes.json` and becomes the
 * item's `lastErrorCode`; the item is retried with backoff unless the worker is stopping.
 */
export class BackgroundWorkError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BackgroundWorkError";
  }
}

const CODE = /^[a-z][a-z0-9_]{0,63}$/u;

/** The item's error code: a background code as thrown, anything else the duty's fallback. */
export function backgroundErrorCode(error: unknown, fallback: string): string {
  return error instanceof BackgroundWorkError && CODE.test(error.code) ? error.code : fallback;
}
