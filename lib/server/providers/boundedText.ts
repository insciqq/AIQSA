import {
  ProviderOutputTooLargeError,
  type ProviderRetainedTextKind,
  type ProviderStreamSafetySnapshot
} from "./streamSafety";

export { ProviderOutputTooLargeError } from "./streamSafety";

function assertPositiveLimit(maxChars: number): void {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new Error("provider_output_limit_invalid");
  }
}

function boundedCharacterCount(input: Readonly<{
  additionalChars: number;
  currentChars: number;
  maxChars: number;
  retainedTextKind: ProviderRetainedTextKind;
  snapshot?: ProviderStreamSafetySnapshot | null;
}>): number {
  assertPositiveLimit(input.maxChars);
  if (
    !Number.isSafeInteger(input.currentChars) ||
    input.currentChars < 0 ||
    !Number.isSafeInteger(input.additionalChars) ||
    input.additionalChars < 0
  ) {
    throw new Error("provider_output_length_invalid");
  }

  const observedChars = input.currentChars + input.additionalChars;
  if (!Number.isSafeInteger(observedChars)) {
    throw new Error("provider_output_length_invalid");
  }
  if (observedChars > input.maxChars) {
    throw new ProviderOutputTooLargeError({
      maxChars: input.maxChars,
      observedChars,
      retainedTextKind: input.retainedTextKind,
      ...(input.snapshot ? { snapshot: input.snapshot } : {})
    });
  }
  return observedChars;
}

export function assertBoundedTextLength(input: Readonly<{
  currentChars?: number;
  fragment: string;
  maxChars: number;
  retainedTextKind: ProviderRetainedTextKind;
  snapshot?: ProviderStreamSafetySnapshot | null;
}>): number {
  const currentChars = input.currentChars ?? 0;
  return boundedCharacterCount({
    additionalChars: input.fragment.length,
    currentChars,
    maxChars: input.maxChars,
    retainedTextKind: input.retainedTextKind,
    snapshot: input.snapshot
  });
}

export function assertBoundedStructuredTextLength(input: Readonly<{
  currentChars?: number;
  maxChars: number;
  retainedTextKind: ProviderRetainedTextKind;
  snapshot?: ProviderStreamSafetySnapshot | null;
  value: unknown;
}>): number {
  type PendingEntry =
    | Readonly<{ kind: "leave"; value: object }>
    | Readonly<{
        context: "array" | "object" | "root";
        kind: "value";
        value: unknown;
      }>;
  const pending: PendingEntry[] = [{
    context: "root",
    kind: "value",
    value: input.value
  }];
  const activePath = new WeakSet<object>();
  let characterCount = input.currentChars ?? 0;

  const jsonStringCharacterCount = (value: string): number => {
    let count = 2;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 ||
        code === 0x0a || code === 0x0c || code === 0x0d) {
        count += 2;
        continue;
      }
      if (code <= 0x1f) {
        count += 6;
        continue;
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          count += 2;
          index += 1;
        } else {
          count += 6;
        }
        continue;
      }
      count += code >= 0xdc00 && code <= 0xdfff ? 6 : 1;
    }
    return count;
  };

  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry) continue;
    if (entry.kind === "leave") {
      activePath.delete(entry.value);
      continue;
    }
    const candidate = entry.value;
    if (typeof candidate === "string") {
      characterCount = boundedCharacterCount({
        additionalChars: entry.context !== "root"
          ? jsonStringCharacterCount(candidate)
          : candidate.length,
        currentChars: characterCount,
        maxChars: input.maxChars,
        retainedTextKind: input.retainedTextKind,
        snapshot: input.snapshot
      });
      continue;
    }
    if (
      typeof candidate === "undefined" ||
      typeof candidate === "function" ||
      typeof candidate === "symbol"
    ) {
      if (entry.context === "array") {
        characterCount = boundedCharacterCount({
          additionalChars: 4,
          currentChars: characterCount,
          maxChars: input.maxChars,
          retainedTextKind: input.retainedTextKind,
          snapshot: input.snapshot
        });
      }
      continue;
    }
    if (candidate === null) {
      characterCount = boundedCharacterCount({
        additionalChars: 4,
        currentChars: characterCount,
        maxChars: input.maxChars,
        retainedTextKind: input.retainedTextKind,
        snapshot: input.snapshot
      });
      continue;
    }
    if (typeof candidate === "boolean" || typeof candidate === "number") {
      const representation = typeof candidate === "number" && !Number.isFinite(candidate)
        ? "null"
        : String(candidate);
      characterCount = boundedCharacterCount({
        additionalChars: representation.length,
        currentChars: characterCount,
        maxChars: input.maxChars,
        retainedTextKind: input.retainedTextKind,
        snapshot: input.snapshot
      });
      continue;
    }
    if (typeof candidate !== "object") {
      throw new Error("provider_output_structure_invalid");
    }
    if (activePath.has(candidate)) {
      throw new Error("provider_output_structure_invalid");
    }
    activePath.add(candidate);
    pending.push({ kind: "leave", value: candidate });
    if (Array.isArray(candidate)) {
      characterCount = boundedCharacterCount({
        additionalChars: 2 + Math.max(0, candidate.length - 1),
        currentChars: characterCount,
        maxChars: input.maxChars,
        retainedTextKind: input.retainedTextKind,
        snapshot: input.snapshot
      });
      for (const item of candidate) {
        pending.push({ context: "array", kind: "value", value: item });
      }
      continue;
    }
    characterCount = boundedCharacterCount({
      additionalChars: 2,
      currentChars: characterCount,
      maxChars: input.maxChars,
      retainedTextKind: input.retainedTextKind,
      snapshot: input.snapshot
    });
    const record = candidate as Record<string, unknown>;
    let propertyCount = 0;
    for (const key of Object.keys(record)) {
      const propertyValue = record[key];
      if (
        typeof propertyValue === "undefined" ||
        typeof propertyValue === "function" ||
        typeof propertyValue === "symbol"
      ) {
        continue;
      }
      characterCount = boundedCharacterCount({
        additionalChars: jsonStringCharacterCount(key) + 1 + (propertyCount > 0 ? 1 : 0),
        currentChars: characterCount,
        maxChars: input.maxChars,
        retainedTextKind: input.retainedTextKind,
        snapshot: input.snapshot
      });
      propertyCount += 1;
      pending.push({ context: "object", kind: "value", value: propertyValue });
    }
  }

  return characterCount;
}

export class BoundedTextAccumulator {
  readonly maxChars: number;
  readonly retainedTextKind: ProviderRetainedTextKind;
  private characterCount = 0;
  private readonly fragments: string[] = [];

  constructor(input: Readonly<{
    initialValue?: string;
    maxChars: number;
    retainedTextKind: ProviderRetainedTextKind;
    snapshot?: ProviderStreamSafetySnapshot | null;
  }>) {
    assertPositiveLimit(input.maxChars);
    this.maxChars = input.maxChars;
    this.retainedTextKind = input.retainedTextKind;
    if (input.initialValue) {
      this.append(input.initialValue, input.snapshot);
    }
  }

  get length(): number {
    return this.characterCount;
  }

  append(fragment: string, snapshot?: ProviderStreamSafetySnapshot | null): void {
    const nextLength = assertBoundedTextLength({
      currentChars: this.characterCount,
      fragment,
      maxChars: this.maxChars,
      retainedTextKind: this.retainedTextKind,
      snapshot
    });
    if (fragment) {
      this.fragments.push(fragment);
    }
    this.characterCount = nextLength;
  }

  replace(value: string, snapshot?: ProviderStreamSafetySnapshot | null): void {
    const nextLength = assertBoundedTextLength({
      fragment: value,
      maxChars: this.maxChars,
      retainedTextKind: this.retainedTextKind,
      snapshot
    });
    this.fragments.length = 0;
    if (value) {
      this.fragments.push(value);
    }
    this.characterCount = nextLength;
  }

  value(): string {
    return this.fragments.join("");
  }
}
