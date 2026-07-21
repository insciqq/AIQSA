import { createGatedRunStreamFixture } from "../support/gatedRunStream";

export const responsiveTouchViewports = [
  { height: 844, keyboardHeight: 500, label: "portrait", width: 384 },
  { height: 390, keyboardHeight: 320, label: "landscape", width: 844 },
  { height: 1024, keyboardHeight: 600, label: "tablet", width: 768 }
] as const;

const responsiveTouchStream = createGatedRunStreamFixture({
  abortMessage: "Responsive stream aborted",
  key: "responsive-touch",
  notReadyError: "responsive_stream_not_ready"
});

export const closeResponsiveTouchStream = responsiveTouchStream.close;
export const emitResponsiveTouchEvent = responsiveTouchStream.emit;
export const installResponsiveTouchStream = responsiveTouchStream.install;
export const waitForResponsiveTouchRequest = responsiveTouchStream.waitForRequestCount;
