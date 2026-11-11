// @vitest-environment node
import { describe, expect, it } from "vitest";
import { declaredContentLength, uploadMimeFamily, uploadSizeClass } from "./uploadRefusal";

describe("upload refusal facts", () => {
  const sizes: Array<[number, string]> = [
    [0, "empty"], [1, "to_1mb"], [1_000_000, "to_1mb"], [1_000_001, "to_10mb"], [25_000_000, "to_25mb"],
    [25_000_001, "to_64mb"], [67_108_864, "to_64mb"], [536_870_912, "to_512mb"], [536_870_913, "over_512mb"]
  ];
  it.each(sizes)("buckets %i bytes as %s", (bytes, expected) => {
    expect(uploadSizeClass(bytes)).toBe(expected);
  });

  it("leaves an unknown or impossible size out", () => {
    expect(uploadSizeClass(undefined)).toBeUndefined();
    expect(uploadSizeClass(-1)).toBeUndefined();
    expect(uploadSizeClass(Number.NaN)).toBeUndefined();
  });

  it.each([
    ["image/png", "image"], [" Application/PDF ", "application"], ["text/plain; charset=utf-8", "text"],
    ["", "none"], ["   ", "none"], ["image", "other"], ["x-private/secret-name", "other"], ["PRIVATE canary", "other"]
  ])("reduces the declared type %j to its family %s", (declared, expected) => {
    expect(uploadMimeFamily(declared)).toBe(expected);
  });

  it("names no family when no type was declared at all", () => {
    expect(uploadMimeFamily(undefined)).toBeUndefined();
    expect(uploadMimeFamily(null)).toBeUndefined();
  });

  it("reads only a plain numeric content length", () => {
    const request = (value?: string) => new Request("http://app.local/api/uploads", value === undefined ? {} : { headers: { "content-length": value } });
    expect(declaredContentLength(request("1024"))).toBe(1024);
    expect(declaredContentLength(request())).toBeUndefined();
    expect(declaredContentLength(request("1e9"))).toBeUndefined();
  });
});
