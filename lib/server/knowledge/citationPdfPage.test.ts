import { describe, expect, it } from "vitest";
import { citationBoxPixelRectangle } from "./citationPdfPage";

describe("citation PDF page geometry", () => {
  it("maps bottom-left PDF coordinates into top-left image pixels", () => {
    expect(citationBoxPixelRectangle({
      bottom: 100,
      coordinateOrigin: "bottom_left",
      left: 50,
      page: 1,
      right: 250,
      top: 180
    }, {
      height: 1_600,
      sourceHeight: 800,
      sourceWidth: 600,
      width: 1_200
    })).toEqual({ height: 160, width: 400, x: 100, y: 1_240 });
  });

  it("rejects degenerate or fully out-of-page coordinates", () => {
    expect(citationBoxPixelRectangle({
      bottom: 900,
      coordinateOrigin: "bottom_left",
      left: 50,
      page: 1,
      right: 250,
      top: 950
    }, {
      height: 1_600,
      sourceHeight: 800,
      sourceWidth: 600,
      width: 1_200
    })).toBeNull();
  });
});
