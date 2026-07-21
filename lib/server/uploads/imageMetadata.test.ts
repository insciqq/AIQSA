import { describe, expect, it } from "vitest";
import { extractImageMetadata } from "./imageMetadata";

const oneByOnePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

describe("image metadata", () => {
  it("extracts stable PNG dimensions", () => {
    expect(extractImageMetadata(oneByOnePng, "image/png")).toEqual({
      format: "png",
      height: 1,
      width: 1
    });
  });
});
