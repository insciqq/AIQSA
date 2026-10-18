// Loaded only by the session page through `loadConnectXterm`, so the
// terminal library and its stylesheet stay out of every other bundle.
import "@xterm/xterm/css/xterm.css";

export { FitAddon } from "@xterm/addon-fit";
export { Terminal } from "@xterm/xterm";
