import { describe, expect, it } from "vitest";
import {
  assertBoundedStructuredTextLength,
  assertBoundedTextLength,
  BoundedTextAccumulator,
  ProviderOutputTooLargeError
} from "./boundedText";

describe("bounded provider-controlled text", () => {
  it("accepts an exact multi-fragment limit and materializes once requested", () => {
    const accumulator = new BoundedTextAccumulator({
      maxChars: 5,
      retainedTextKind: "visible_output"
    });

    accumulator.append("Hel");
    accumulator.append("lo");

    expect(accumulator.length).toBe(5);
    expect(accumulator.value()).toBe("Hello");
  });

  it("rejects the first character over without retaining the overflow fragment", () => {
    const accumulator = new BoundedTextAccumulator({
      maxChars: 5,
      retainedTextKind: "tool_arguments"
    });
    accumulator.append("Hello");

    let failure: unknown;
    try {
      accumulator.append("!");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ProviderOutputTooLargeError);
    expect(failure).toMatchObject({
      code: "provider_output_too_large",
      limit: 5,
      maxChars: 5,
      message: "provider_output_too_large",
      name: "ProviderOutputTooLargeError",
      observedChars: 6,
      retainedTextKind: "tool_arguments",
      termination: "output_limit",
      unit: "characters"
    });
    expect(accumulator.length).toBe(5);
    expect(accumulator.value()).toBe("Hello");
  });

  it("checks replacements independently and counts JavaScript string code units", () => {
    const accumulator = new BoundedTextAccumulator({
      initialValue: "old",
      maxChars: 4,
      retainedTextKind: "signature"
    });

    accumulator.replace("😀😀");
    expect(accumulator.length).toBe(4);
    expect(accumulator.value()).toBe("😀😀");
    expect(() => accumulator.replace("😀😀x")).toThrow("provider_output_too_large");
    expect(accumulator.value()).toBe("😀😀");
  });

  it("supports count-only guards without constructing a concatenated string", () => {
    expect(assertBoundedTextLength({
      currentChars: 2,
      fragment: "abc",
      maxChars: 5,
      retainedTextKind: "reasoning"
    })).toBe(5);
    expect(() => assertBoundedTextLength({
      currentChars: 2,
      fragment: "abcd",
      maxChars: 5,
      retainedTextKind: "reasoning"
    })).toThrow("provider_output_too_large");
  });

  it("matches escaped JSON length and counts repeated aliases on every path", () => {
    const shared: Record<string, unknown> = { text: "\"\\\n" };
    const value: Record<string, unknown> = {
      "escaped\"key": "\"",
      left: shared,
      right: shared
    };
    const expected = JSON.stringify(value).length;

    const retainedChars = assertBoundedStructuredTextLength({
      maxChars: 100,
      retainedTextKind: "tool_arguments",
      value
    });
    expect(retainedChars).toBe(expected);
    expect(assertBoundedStructuredTextLength({
      maxChars: retainedChars,
      retainedTextKind: "tool_arguments",
      value
    })).toBe(retainedChars);
    expect(() => assertBoundedStructuredTextLength({
      maxChars: retainedChars - 1,
      retainedTextKind: "tool_arguments",
      value
    })).toThrow("provider_output_too_large");
  });

  it("rejects cycles and keeps an already-serialized root string as raw text", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(assertBoundedStructuredTextLength({
      maxChars: 5,
      retainedTextKind: "tool_arguments",
      value: "Hello"
    })).toBe(5);
    expect(() => assertBoundedStructuredTextLength({
      maxChars: 100,
      retainedTextKind: "tool_arguments",
      value: cyclic
    })).toThrow("provider_output_structure_invalid");
  });
});
