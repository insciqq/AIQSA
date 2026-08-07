const debugSectionTitles = new Set([
  "artifacts",
  "errors",
  "provider parameters",
  "request preview",
  "usage"
]);

const structuredSectionTitles = new Set([...debugSectionTitles, "question", "search"]);

function normalizedTitle(title: string): string {
  return title
    .replace(/[*_`]/g, "")
    .replace(/[:#]+$/g, "")
    .trim()
    .toLowerCase();
}

type Heading = {
  index: number;
  title: string;
  titleEnd: number;
};

function headings(markdown: string): Heading[] {
  const results: Heading[] = [];
  let fence: { character: "`" | "~"; length: number } | null = null;
  let lineStart = 0;

  while (lineStart < markdown.length) {
    const newlineIndex = markdown.indexOf("\n", lineStart);
    const nextLineStart = newlineIndex === -1 ? markdown.length : newlineIndex + 1;
    let lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex;
    if (lineEnd > lineStart && markdown[lineEnd - 1] === "\r") {
      lineEnd -= 1;
    }
    const line = markdown.slice(lineStart, lineEnd);

    if (fence) {
      const closingFence = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (
        closingFence &&
        closingFence[1][0] === fence.character &&
        closingFence[1].length >= fence.length
      ) {
        fence = null;
      }
    } else {
      const openingFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      const fenceCharacter = openingFence?.[1][0];
      const validOpeningFence =
        openingFence && !(fenceCharacter === "`" && openingFence[2].includes("`"));

      if (validOpeningFence && (fenceCharacter === "`" || fenceCharacter === "~")) {
        fence = {
          character: fenceCharacter,
          length: openingFence[1].length
        };
      } else {
        const heading = /^(#{1,3})\s+(.+)$/.exec(line);
        if (heading) {
          results.push({
            index: lineStart,
            title: normalizedTitle(heading[2]),
            titleEnd: lineStart + heading[0].length
          });
        }
      }
    }

    if (newlineIndex === -1) {
      break;
    }
    lineStart = nextLineStart;
  }

  return results;
}

export function visibleAnswerText(text: string): string {
  const allHeadings = headings(text);
  const answerHeading = allHeadings.find((heading) => heading.title === "answer");

  if (answerHeading) {
    const followingDebugHeading = allHeadings.find(
      (heading) => heading.index > answerHeading.index && debugSectionTitles.has(heading.title)
    );

    return text
      .slice(answerHeading.titleEnd, followingDebugHeading?.index ?? text.length)
      .trim();
  }

  const debugHeadingTitles = new Set(
    allHeadings
      .filter((heading) => debugSectionTitles.has(heading.title))
      .map((heading) => heading.title)
  );
  const hasTemplateSignature =
    debugHeadingTitles.size >= 2 &&
    (debugHeadingTitles.has("provider parameters") || debugHeadingTitles.has("request preview"));

  if (hasTemplateSignature) {
    const keep: string[] = [];
    let cursor = 0;

    for (const [index, heading] of allHeadings.entries()) {
      if (!structuredSectionTitles.has(heading.title)) {
        continue;
      }
      if (heading.index > cursor) {
        keep.push(text.slice(cursor, heading.index));
      }
      cursor = allHeadings[index + 1]?.index ?? text.length;
    }

    if (cursor < text.length) {
      keep.push(text.slice(cursor));
    }

    return keep.join("").trim();
  }

  return text.trim();
}
