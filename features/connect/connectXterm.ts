// Loaded only by the session page through `loadConnectXterm`, so the
// terminal library, its stylesheet and the symbols font stay out of every
// other bundle.
import "@xterm/xterm/css/xterm.css";
import { Noto_Sans_Symbols } from "next/font/google";

export { FitAddon } from "@xterm/addon-fit";
export { Terminal } from "@xterm/xterm";

/**
 * Technical symbols and dingbats agents draw with (`⎿`, `❯`), which many
 * systems have in no installed font. Self-hosted by the build like the other
 * fonts; its unicode range downloads it only once such a glyph is used.
 */
const symbols = Noto_Sans_Symbols({
  adjustFontFallback: false,
  display: "swap",
  fallback: [],
  preload: false,
  subsets: ["symbols"],
  weight: "400"
});

export const CONNECT_TERMINAL_SYMBOLS_FONT_FAMILY: string | undefined = symbols.style.fontFamily;
