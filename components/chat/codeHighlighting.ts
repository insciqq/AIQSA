"use client";

import type { HighlighterCore } from "shiki/core";

export const highlightedCodeLanguages = [
  "ts",
  "tsx",
  "js",
  "json",
  "bash",
  "shell",
  "python",
  "go",
  "rust",
  "sql",
  "yaml",
  "html",
  "css",
  "md",
  "diff"
] as const;

export type HighlightedCodeLanguage = (typeof highlightedCodeLanguages)[number];

export type CodeHighlightResult = {
  html: string;
  language: HighlightedCodeLanguage;
};

type ShikiLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "json"
  | "bash"
  | "shellscript"
  | "python"
  | "go"
  | "rust"
  | "sql"
  | "yaml"
  | "html"
  | "css"
  | "markdown"
  | "diff";

const languageAliases = new Map<string, { display: HighlightedCodeLanguage; shiki: ShikiLanguage }>([
  ["ts", { display: "ts", shiki: "typescript" }],
  ["typescript", { display: "ts", shiki: "typescript" }],
  ["tsx", { display: "tsx", shiki: "tsx" }],
  ["js", { display: "js", shiki: "javascript" }],
  ["javascript", { display: "js", shiki: "javascript" }],
  ["json", { display: "json", shiki: "json" }],
  ["bash", { display: "bash", shiki: "bash" }],
  ["sh", { display: "shell", shiki: "shellscript" }],
  ["shell", { display: "shell", shiki: "shellscript" }],
  ["zsh", { display: "shell", shiki: "shellscript" }],
  ["python", { display: "python", shiki: "python" }],
  ["py", { display: "python", shiki: "python" }],
  ["go", { display: "go", shiki: "go" }],
  ["rust", { display: "rust", shiki: "rust" }],
  ["rs", { display: "rust", shiki: "rust" }],
  ["sql", { display: "sql", shiki: "sql" }],
  ["yaml", { display: "yaml", shiki: "yaml" }],
  ["yml", { display: "yaml", shiki: "yaml" }],
  ["html", { display: "html", shiki: "html" }],
  ["css", { display: "css", shiki: "css" }],
  ["md", { display: "md", shiki: "markdown" }],
  ["markdown", { display: "md", shiki: "markdown" }],
  ["diff", { display: "diff", shiki: "diff" }]
]);

let highlighterPromise: Promise<HighlighterCore> | null = null;
const highlightCache = new Map<string, Promise<CodeHighlightResult | null>>();
export const CODE_HIGHLIGHT_CACHE_LIMIT = 250;

export function resolveCodeLanguage(language: string): HighlightedCodeLanguage | null {
  const normalized = language.trim().toLowerCase();
  return languageAliases.get(normalized)?.display ?? null;
}

function resolveShikiLanguage(language: string): { display: HighlightedCodeLanguage; shiki: ShikiLanguage } | null {
  return languageAliases.get(language.trim().toLowerCase()) ?? null;
}

async function createAiqsaHighlighter(): Promise<HighlighterCore> {
  const [
    { createHighlighterCore },
    { createJavaScriptRegexEngine },
    darkTheme,
    lightTheme,
    ts,
    tsx,
    js,
    json,
    bash,
    shell,
    python,
    go,
    rust,
    sql,
    yaml,
    html,
    css,
    markdown,
    diff
  ] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-dark.mjs"),
    import("shiki/themes/github-light.mjs"),
    import("shiki/langs/typescript.mjs"),
    import("shiki/langs/tsx.mjs"),
    import("shiki/langs/javascript.mjs"),
    import("shiki/langs/json.mjs"),
    import("shiki/langs/bash.mjs"),
    import("shiki/langs/shellscript.mjs"),
    import("shiki/langs/python.mjs"),
    import("shiki/langs/go.mjs"),
    import("shiki/langs/rust.mjs"),
    import("shiki/langs/sql.mjs"),
    import("shiki/langs/yaml.mjs"),
    import("shiki/langs/html.mjs"),
    import("shiki/langs/css.mjs"),
    import("shiki/langs/markdown.mjs"),
    import("shiki/langs/diff.mjs")
  ]);

  return createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    langs: [
      ts.default,
      tsx.default,
      js.default,
      json.default,
      bash.default,
      shell.default,
      python.default,
      go.default,
      rust.default,
      sql.default,
      yaml.default,
      html.default,
      css.default,
      markdown.default,
      diff.default
    ],
    themes: [darkTheme.default, lightTheme.default]
  });
}

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createAiqsaHighlighter();
  return highlighterPromise;
}

export function highlightCodeBlock(code: string, language: string): Promise<CodeHighlightResult | null> {
  const resolved = resolveShikiLanguage(language);
  if (!resolved) {
    return Promise.resolve(null);
  }

  const cacheKey = `${resolved.shiki}\0${code}`;
  const cached = highlightCache.get(cacheKey);
  if (cached) {
    highlightCache.delete(cacheKey);
    highlightCache.set(cacheKey, cached);
    return cached;
  }

  const highlighted = getHighlighter()
    .then((highlighter) => ({
      html: highlighter.codeToHtml(code, {
        defaultColor: false,
        lang: resolved.shiki,
        themes: {
          dark: "github-dark",
          light: "github-light"
        }
      }),
      language: resolved.display
    }))
    .catch(() => null);

  // Bound the long-session client cache; Map iteration order gives simple LRU eviction.
  if (highlightCache.size >= CODE_HIGHLIGHT_CACHE_LIMIT) {
    const oldestKey = highlightCache.keys().next().value;
    if (oldestKey) {
      highlightCache.delete(oldestKey);
    }
  }
  highlightCache.set(cacheKey, highlighted);
  return highlighted;
}
