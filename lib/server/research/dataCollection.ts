import { RECORD_EVIDENCE_TOOL_NAME, type ResearchDataset } from "../../contracts/research";

/**
 * Owners' reviews as counts for one exact model. Two purchase answers said long reviews of their picks could not be established while the
 * cards held many, so the evidence could not tell the candidates apart. This holds the method in the server's words, carried by the browser
 * guide, and what a sample's size and counts may become in a report. A script does the collecting in the Workspace, under the Workspace's own
 * policy: no new destination, and nothing here goes past a block. It needs nothing from the guest image beyond the browser it already has.
 */

/** Below this a sample is small: one review then moves a share by more than three points, so a percentage claims a precision it does not have. */
export const RESEARCH_SMALL_SAMPLE_BELOW = 30;

/** Equal to `WORKSPACE_GUIDE_PATHS.browser`, as its test keeps it: the guides read this module, so this one cannot read them. */
export const RESEARCH_REVIEWS_GUIDE_PATH = "/workspace/guides/browser.md";

const SECTION = "Owners' reviews as counts";

/** What a researcher's brief ends with about this method: a brief rides on a short bound, so the method itself stays in the guide. */
export const RESEARCH_REVIEWS_REFERENCE =
  `When owners' reviews could tell candidates apart, count them for the exact model and size by script and record a dataset: read "${SECTION}" in ${RESEARCH_REVIEWS_GUIDE_PATH}.`;

/**
 * Rides on the browser guide, the one guide read before opening a site, which a researcher already reaches. A guide file of its own would
 * also change the installer's fixed names (`lib/server/workspace/guideGuest.ts`). What the examples must be printed from is the quote check's
 * reading of a page (`researchEvidenceKind`, `lib/server/research/sources.ts`). One guide per VM is written at its boot and serves all of a
 * chat's runs, so it cannot vary by run, and it says itself that only research offers the tool: an ordinary chat scraping reviews reads this too.
 */
export const RESEARCH_REVIEWS_GUIDANCE = [
  "",
  `## ${SECTION}`,
  "",
  "For research, when owners' reviews could tell candidates apart. A card can hold hundreds, and a count for the exact model says more than the few you happen to read. This is reading a page, under the rules above.",
  "",
  "- Load: open the card's reviews. Press the site's own \"show more\" or next-page control with `click`, or `scroll bottom` where the list grows by itself, then `wait --text`. In Python loop over `b.click`, `b.scroll` and `b.wait_for`. Read with `text N --start K`, or with `js`, which only reads and returns at most 8000 characters, so take reviews in slices. Save each review's whole text to a file under /workspace/project.",
  "- Filter: a card often merges the reviews of all its variants, and its size picker may not separate them. Read the model and size from each review's own text: a line such as `Размер: 160×200`, or its body (`брали 160 на 200`). The size selected on the card says nothing about a review. Keep what names this model and size, and count what you drop: other sizes, other models, no size named. If no review names a size, count the model's reviews and say that sizes could not be told apart. With no review of it at all, say so; in research, record `not_found` for its cell.",
  "- Stop at the end of the list, when two loads in a row add nothing, or at about 500 reviews read. Faults show late, so take old reviews too: never only the newest.",
  "- Count: for each kind of complaint (sagging, smell, a broken zip) how many kept reviews report it, and how many say how long they owned it, such as a year or more. A keyword only finds candidates: read them, since `не просел` is no complaint.",
  "- Print, then record: print the reviews you will quote word for word, from the command that reads them in the browser. The server checks quotes against that output, and a file read back with `cat` is no page.",
  `- Report: give the sample, the counts, what you dropped and a few reviews word for word in your answer. Only a research run offers ${RECORD_EVIDENCE_TOOL_NAME}: if this one does, call it with kind \`dataset\`, one per exact model and size: \`row_key\` the candidate, \`source_class\` owner_reviews, \`standing\` confirmed when you read the examples on the page (the count is of what owners wrote, not proof that the complaint is true), \`url\` the card. \`method\`: the site, how you went through the list and how you told the variant. \`sample_size\`: the reviews kept, which the counts are out of, never all you read. \`left_out\`: what the filter dropped, with numbers, where you stopped, and that sizes could not be told apart if they could not. \`counts\`: one per complaint or time owned. \`examples\`: a few reviews word for word, each with its link.`,
  `- Fewer than ${RESEARCH_SMALL_SAMPLE_BELOW} kept reviews is a small sample: say so, and give counts such as 3 of 11, never a percentage or a share.`,
  "- A block, a CAPTCHA or a sign-in ends collecting there: never work around it. In research your method says what goes to the user, and otherwise record the site as `unreachable` and go on; in any other run say so in your answer. Reviews already read still count, and say where you stopped. A proxy the user saved works here as on any page."
].join("\n");

export const researchSampleIsSmall = (sampleSize: number) => sampleSize < RESEARCH_SMALL_SAMPLE_BELOW;

/** A whole percent, except that rounding never turns a few into none or nearly all into all. */
function shareOf(count: number, sampleSize: number): string {
  const percent = Math.round((count / sampleSize) * 100);
  if (percent === 0 && count > 0) return "under 1%";
  return percent === 100 && count < sampleSize ? "over 99%" : `${percent}%`;
}

/** What a report may say of one count: "3 of 11", and a share beside it only when the sample can carry one. */
export function researchCountWords(count: number, sampleSize: number): string {
  const counted = `${count} of ${sampleSize}`;
  return researchSampleIsSmall(sampleSize) ? counted : `${counted} (${shareOf(count, sampleSize)})`;
}

/** What a report may say of a dataset's tally, the sample's size first. */
export function researchDatasetWords(dataset: Pick<ResearchDataset, "counts" | "sampleSize">): string {
  const sample = researchSampleIsSmall(dataset.sampleSize) ? `Small sample of ${dataset.sampleSize}` : `Sample of ${dataset.sampleSize}`;
  const counts = dataset.counts.map(({ count, label }) => `${label}: ${researchCountWords(count, dataset.sampleSize)}`);
  return counts.length > 0 ? `${sample}. ${counts.join("; ")}.` : `${sample}.`;
}

/** What the agent hears at once of a small sample; null for one that is not. */
export function researchSmallSampleNote(dataset: Pick<ResearchDataset, "counts" | "sampleSize">): string | null {
  if (!researchSampleIsSmall(dataset.sampleSize)) return null;
  const first = dataset.counts[0];
  const example = first ? ` (${first.label}: ${researchCountWords(first.count, dataset.sampleSize)})` : "";
  return `Small sample: ${dataset.sampleSize}, below ${RESEARCH_SMALL_SAMPLE_BELOW}. Report it as small and in counts${example}, never as a percentage.`;
}

/** Whether a claim already reads as a rate, which a small sample cannot carry. */
export const researchClaimGivesRate = (claim: string) => /\d\s*(?:%|процент|percent|por ciento)/iu.test(claim);
