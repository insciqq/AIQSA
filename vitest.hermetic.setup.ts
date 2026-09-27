// Honor per-file environment overrides without loading DOM matchers in Node.
if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
}

export {};
