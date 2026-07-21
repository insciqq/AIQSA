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
  const pattern = /^#{1,3}\s+(.+)$/gm;
  let match = pattern.exec(markdown);

  while (match) {
    results.push({
      index: match.index,
      title: normalizedTitle(match[1]),
      titleEnd: pattern.lastIndex
    });
    match = pattern.exec(markdown);
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

  if (allHeadings.some((heading) => structuredSectionTitles.has(heading.title))) {
    const keep: string[] = [];
    let cursor = 0;

    for (const heading of allHeadings) {
      if (heading.index > cursor) {
        keep.push(text.slice(cursor, heading.index));
      }

      const nextHeading = allHeadings.find((candidate) => candidate.index > heading.index);
      cursor = structuredSectionTitles.has(heading.title) ? nextHeading?.index ?? text.length : heading.index;
    }

    if (cursor < text.length) {
      keep.push(text.slice(cursor));
    }

    const cleaned = keep.join("").trim();
    return cleaned || text.trim();
  }

  return text.trim();
}
