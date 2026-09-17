/** Bounded plain-text preview of an administrator-authored Markdown message. */
export function announcementExcerpt(body: string): string {
  const text = body
    .replace(/\r\n?/gu, "\n")
    .replace(/^ {0,3}(?:`{3,}|~{3,})[^\n]*$/gmu, "")
    .replace(/^ {0,3}(?:(?:[-*_][ \t]*){3,}|=+|\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?)[ \t]*$/gmu, "")
    .replace(/^(?:[ \t]*(?:#{1,6}[ \t]+|>[ \t]*|[-+*][ \t]+|\d+[.)][ \t]+))+/gmu, "")
    .replace(/^[ \t]*\[[ xX]\][ \t]+/gmu, "")
    .replace(/[ \t]+#+[ \t]*$/gmu, "")
    .replace(/!?\[([^\[\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/gu, "$1")
    .replace(/!?\[([^\[\]\n]*)\]\[[^\[\]\n]*\]/gu, "$1")
    .replace(/^\s*\[[^\[\]\n]+\]:[^\n]*$/gmu, "")
    .replace(/<(https?:\/\/[^<>\s]+)>/gu, "$1")
    .replace(/<[^<>]*>/gu, "")
    .replace(/[*_`~]/gu, "")
    .replace(/\|/gu, " ")
    .replace(/\\([\\[\]{}()#+.!-])/gu, "$1")
    .replace(/\s+/gu, " ").trim();
  return text.length <= 180 ? text : `${text.slice(0, 179).replace(/[\uD800-\uDBFF]$/u, "")}…`;
}
