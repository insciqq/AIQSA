type ConnectXtermModule = typeof import("./connectXterm");

let xtermModule: Promise<ConnectXtermModule> | null = null;

/** The terminal library, loaded once on the first session page. */
export function loadConnectXterm(): Promise<ConnectXtermModule> {
  xtermModule ??= import("./connectXterm").catch((error: unknown) => {
    // A failed chunk load may succeed on the next session page.
    xtermModule = null;
    throw error;
  });
  return xtermModule;
}
