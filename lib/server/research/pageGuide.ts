import { ARTIFACT_TOOL_NAME } from "../tools/artifact";

/**
 * How the main agent writes a finished research's page (operator decisions 2026-11-05). Reports differ, so no template fits them: the model writes each
 * page, and this guide tells it how, written like a skill. The product has no system Skills (`lib/server/skills/` holds users' and shared ones), so it ships
 * here and changing it takes a release. The step that hands it over is `page.ts`.
 *
 * What the guide must hold, from the operator: the answer to the reader's question first; a form that follows the report; tables and charts only where
 * they help; no pictures of products; only what the report says, with its figures, links and order; no process notes or technical labels; the report's
 * language; short, responsive, light and dark, printable. The numbers behind a chart sit in a JSON data block, and every figure the reader sees is in the
 * page's markup or such a block, so a check can compare them with the report without running the page.
 */
export const RESEARCH_PAGE_GUIDE = `# Research page (from the server)

The research has ended and the report below is final. Write one web page of it with a single ${ARTIFACT_TOOL_NAME} call. The answer in the chat keeps the whole report; the page is how a reader takes it in at a glance, so it shows the same content in the form that is quickest to read.

## The answer first
- The top of the page answers the reader's question in two to four short lines, as the report's opening summary does: the recommendation and its main reason, or the main finding.
- Everything else follows below it, in the report's order.

## The form follows the report
- A choice among options (what to buy, which service, plan or tool to take): a comparison table of the options the report compares, one row per option in the report's order of recommendation with its pick first, and a column for each criterion that tells them apart, such as price, the key specifications and what the report says for and against each. Mark the pick and every alternative the report recommends. Give each recommended option's offer with its price, seller and link exactly as the report gives them. Where the report gives the options' ratings, the table shows each one's score with its number of ratings and the platform exactly as the report gives them, with a small sample and the main complaints beside it as the report says them. Add a chart of a figure that separates the options, such as price or a measured value, only when the report gives it for most of them.
- A knowledge question (what is true, how something works, what changed): the findings as short sections, each with a plain heading, the most important first, each with the sources the report gives for it. Add a timeline when the report's dates are what matters, such as a history or a sequence of rules or releases, and a table when it compares a few things on the same points.
- Any other report: its own structure, made easy to scan.
- Leave a table or chart out where the text says it as well: one or two numbers need no chart, and three short items need no table.

## Tables and charts
- Use real <table> markup with a header row. On a narrow screen a wide table scrolls inside its own box; the page itself never scrolls sideways.
- Draw charts as inline SVG: bars to compare options, a line only for a value over time. Each chart has a title, axes labelled with their units or currency, and the value written on each bar or point, so it reads without hovering and in print.
- Only for a chart inline SVG cannot draw, load a chart library with a <script src> from a host the ${ARTIFACT_TOOL_NAME} description names, at an exact version, as that description says: the server freezes it into the page.
- Put the numbers behind every chart, with their units or currency, in a <script type="application/json"> block in index.html, and draw the chart from that block or write the same numbers into the SVG.
- Every figure the reader sees is written in the page's markup or in such a block. No script computes, converts or makes up a figure, and the open page requests nothing.

## Only what the report says
- Use the report's options, figures with their units and currency, dates, names and links exactly as it writes them, and keep its order of recommendation. Do not round, convert or recompute a figure.
- Add nothing of your own: no other options, specifications, prices, ratings, scores, pros, cons or claims, and nothing from memory.
- Where the report says something is uncertain, disputed or could not be found, say so at that place in the same plain words.
- Caveats may follow the report: what the answer says beneath it of facts the sources did not confirm or bear out only in part, and of evidence against the conclusion. Put each beside the option and criterion it names, in a short plain line in the report's language, and never show such a fact as established, in a table cell or a chart included: mark the cell and say why in that line. A caveat that names no option goes right under the answer at the top.
- Link each source and offer to the report's own URL; never invent, shorten or change one.
- No pictures: no photos or drawings of products, no logos and no image files. Text, tables and charts are enough.

## What stays off the page
- Nothing about how the research was done: no notes on checks, agents, records, sources that could not be opened, time or method, and no labels such as "not checked", "verified" or "confirmed by a second source", no confidence scores, record ids or internal keys. A caveat the reader needs stays, said in plain words about the fact, such as that the sources do not bear it out, never about how it was checked.
- No text twice, and no paragraph copied whole where a table row or a short line says it.

## Language and layout
- Every word on the page is in the report's language: headings, table labels, chart titles and the artifact's title too.
- Keep it short: the answer on the first screen, and every detail within a few minutes of reading.
- One file, index.html, with its styles in a <style> element and its data in the page itself; the only other thing it loads is a chart library the server froze, when one is needed. No web fonts and no images: use the system font stack.
- Responsive: a viewport meta tag, box-sizing: border-box, fluid widths and no fixed minimum widths.
- Light and dark: colors as CSS variables switched by prefers-color-scheme, with enough contrast in both.
- Print: an @media print block with dark text on white, no shadows or background fills, and tables and charts kept whole where they fit.

## The call
- Call ${ARTIFACT_TOOL_NAME} once with intent "create", kind "html", entrypoint "index.html", one file at path "index.html" with mimeType "text/html", and a short title naming what was researched.
- Make that call and nothing else: no other tool and no message. The server shows the page with the answer.`;

/**
 * The step's one instruction: the guide, what was researched, the report the page is written from and the answer's caveats, which is all the step's model reads
 * besides its system prompt. The caveats are the server's own words, never the checker's (`researchContentNotes`).
 */
export function researchPageInstruction(input: Readonly<{ caveats: readonly string[]; goal: string; report: string }>): string {
  const caveats = input.caveats.length > 0 ? `\n\n## Caveats\n${input.caveats.map((caveat) => `- ${caveat.replace(/\s+/gu, " ").trim()}`).join("\n")}` : "";
  return `${RESEARCH_PAGE_GUIDE}\n\n## What was researched\n${input.goal.trim()}\n\n## The report (the page's only source)\n<report>\n${input.report.trim()}\n</report>${caveats}`;
}

/** What the model reads when the page's check sends it back: the check's words, then how to correct the version it made. */
export function researchPageSendBack(message: string, versionId: string): string {
  return `The page does not match the report: ${message.trim()}\n\nCorrect only that with one ${ARTIFACT_TOOL_NAME} call: intent "update", base_version_id ` +
    `${JSON.stringify(versionId)}, and edits to index.html (or the whole file). Make that call and nothing else.`;
}
