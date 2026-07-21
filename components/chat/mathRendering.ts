export const MATH_RENDER_CACHE_LIMIT = 256;
export const MATH_SOURCE_MAX_CHARACTERS = 20_000;

type MathRenderResult = {
  html: string;
};

type CachedMath = MathRenderResult | null;

const renderedMathCache = new Map<string, CachedMath>();
let katexPromise: Promise<typeof import("katex")> | null = null;
const trustRequiredCommand = /\\(?:href|url|includegraphics|html(?:Class|Id|Style|Data))\b/;

function cacheResult(key: string, result: CachedMath): CachedMath {
  renderedMathCache.delete(key);
  renderedMathCache.set(key, result);

  while (renderedMathCache.size > MATH_RENDER_CACHE_LIMIT) {
    const oldestKey = renderedMathCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) {
      break;
    }
    renderedMathCache.delete(oldestKey);
  }

  return result;
}

async function loadKatex(): Promise<typeof import("katex")> {
  katexPromise ??= import("katex");
  return katexPromise;
}

export async function renderMathExpression(source: string, displayMode: boolean): Promise<MathRenderResult | null> {
  const expression = source.trim();
  if (!expression || expression.length > MATH_SOURCE_MAX_CHARACTERS || trustRequiredCommand.test(expression)) {
    return null;
  }

  const key = `${displayMode ? "display" : "inline"}\0${expression}`;
  if (renderedMathCache.has(key)) {
    const cached = renderedMathCache.get(key) ?? null;
    cacheResult(key, cached);
    return cached;
  }

  try {
    const katex = await loadKatex();
    const html = katex.renderToString(expression, {
      displayMode,
      maxExpand: 1_000,
      maxSize: 10,
      output: "htmlAndMathml",
      strict: "error",
      throwOnError: true,
      trust: false
    });

    return cacheResult(key, { html });
  } catch {
    return cacheResult(key, null);
  }
}

export function clearMathRenderingCacheForTest(): void {
  renderedMathCache.clear();
  katexPromise = null;
}

export function mathRenderingCacheSizeForTest(): number {
  return renderedMathCache.size;
}
