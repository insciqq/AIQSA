/**
 * The research method's shapes (operator decisions 2026-11-01): a plan of
 * questions with source classes assigned up front, findings as claim, link,
 * verbatim quote and source class, a draft of the report, and what a gate says
 * of a draft. Research stays inside one run that ends in an ordinary answer.
 * Pure and bounded: the tools decode what a model sent with these.
 */

export const START_RESEARCH_TOOL_NAME = "start_research";
export const SUBMIT_RESEARCH_DRAFT_TOOL_NAME = "submit_research_draft";

/** Where a claim's evidence comes from. Each class is assigned, or skipped with a reason, before anyone searches. */
export const RESEARCH_SOURCE_CLASSES = ["primary_official", "independent_tests", "owner_reviews", "action_channel"] as const;
export type ResearchSourceClass = (typeof RESEARCH_SOURCE_CLASSES)[number];

/** What a report may say of a claim: it keeps these three apart. */
export const RESEARCH_STANDINGS = ["confirmed", "claimed", "not_verified"] as const;
export type ResearchStanding = (typeof RESEARCH_STANDINGS)[number];

export const RESEARCH_LIMITS = Object.freeze({
  claimCharacters: 2_000,
  findings: 300,
  goalCharacters: 2_000,
  questionCharacters: 1_000,
  questions: 16,
  quoteCharacters: 4_000,
  reasonCharacters: 1_000,
  reportCharacters: 200_000,
  sitesPerQuestion: 8,
  siteCharacters: 256,
  targetCharacters: 512,
  unreachable: 64,
  urlCharacters: 2_048
});

export type ResearchQuestion = Readonly<{
  question: string;
  /** Sites the user named for this question: a CAPTCHA there goes to the user, it is never skipped. */
  sites: readonly string[];
  sourceClasses: readonly ResearchSourceClass[];
}>;

/** A source class the plan leaves out, and why: a class never goes missing silently. */
export type ResearchSkippedClass = Readonly<{ reason: string; sourceClass: ResearchSourceClass }>;

export type ResearchPlan = Readonly<{
  goal: string;
  questions: readonly ResearchQuestion[];
  skipped: readonly ResearchSkippedClass[];
}>;

export type ResearchFinding = Readonly<{
  claim: string;
  /** Copied verbatim from the page an agent opened. */
  quote: string;
  sourceClass: ResearchSourceClass;
  standing: ResearchStanding;
  url: string;
}>;

/** What could not be reached and why; the reason reaches the report. */
export type ResearchUnreachable = Readonly<{
  reason: string;
  sourceClass: ResearchSourceClass | null;
  target: string;
}>;

export type ResearchDraft = Readonly<{
  findings: readonly ResearchFinding[];
  /**
   * `reserved_call`: the model called `submit_research_draft`. `plain_text`: it wrote a final message instead, twice
   * or with its tools closed, so the draft has its text and no findings.
   */
  origin: "plain_text" | "reserved_call";
  /** The report as the user will read it: an accepted draft is published as it is, with no further model call. */
  report: string;
  unreachable: readonly ResearchUnreachable[];
}>;

/** A gate's word on one draft. A gate that fails or runs out of time never loses the answer (`lib/server/research/gates.ts`). */
export type ResearchGateResult =
  | Readonly<{ kind: "pass"; notes?: readonly string[] }>
  | Readonly<{
    kind: "send_back";
    /** What the main agent reads as its call's result: what to do before it submits again. */
    message: string;
    notes?: readonly string[];
    /** What the answer says instead when no time is left to send it back. */
    unresolvedNote?: string;
  }>;

export type DecodedResearch<T> = Readonly<{ ok: true; value: T }> | Readonly<{ message: string; ok: false }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

export const isResearchSourceClass = (value: unknown): value is ResearchSourceClass =>
  (RESEARCH_SOURCE_CLASSES as readonly unknown[]).includes(value);

const refused = (message: string) => ({ message, ok: false as const });

/** A plan as `start_research` takes it; the message names the field to correct. */
export function decodeResearchPlan(value: unknown): DecodedResearch<ResearchPlan> {
  if (!isRecord(value)) return refused("The arguments must be one object.");
  const limits = RESEARCH_LIMITS;
  if (!boundedText(value.goal, limits.goalCharacters)) return refused(`goal must be 1 to ${limits.goalCharacters} characters.`);
  if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > limits.questions) {
    return refused(`questions must list 1 to ${limits.questions} questions.`);
  }
  const questions: ResearchQuestion[] = [];
  for (const [index, entry] of value.questions.entries()) {
    const at = `questions[${index}]`;
    if (!isRecord(entry) || !boundedText(entry.question, limits.questionCharacters)) {
      return refused(`${at}.question must be 1 to ${limits.questionCharacters} characters.`);
    }
    const classes = entry.source_classes;
    if (!Array.isArray(classes) || classes.length < 1 || !classes.every(isResearchSourceClass)) {
      return refused(`${at}.source_classes must name at least one of ${RESEARCH_SOURCE_CLASSES.join(", ")}.`);
    }
    const sites = entry.sites ?? [];
    if (!Array.isArray(sites) || sites.length > limits.sitesPerQuestion ||
      !sites.every((site) => boundedText(site, limits.siteCharacters))) {
      return refused(`${at}.sites must list at most ${limits.sitesPerQuestion} sites the user named.`);
    }
    questions.push({ question: entry.question, sites, sourceClasses: [...new Set(classes)] });
  }
  const rawSkipped = value.skipped_source_classes ?? [];
  if (!Array.isArray(rawSkipped) || rawSkipped.length > RESEARCH_SOURCE_CLASSES.length) {
    return refused("skipped_source_classes must be a list of source classes with their reasons.");
  }
  const skipped: ResearchSkippedClass[] = [];
  for (const entry of rawSkipped) {
    if (!isRecord(entry) || !isResearchSourceClass(entry.source_class) || !boundedText(entry.reason, limits.reasonCharacters)) {
      return refused(`Each skipped source class needs source_class and a reason of 1 to ${limits.reasonCharacters} characters.`);
    }
    skipped.push({ reason: entry.reason, sourceClass: entry.source_class });
  }
  const assigned = new Set<ResearchSourceClass>([...questions.flatMap((question) => question.sourceClasses),
    ...skipped.map((entry) => entry.sourceClass)]);
  const missing = RESEARCH_SOURCE_CLASSES.filter((sourceClass) => !assigned.has(sourceClass));
  if (missing.length > 0) {
    return refused(`Assign ${missing.join(", ")} to a question, or list it in skipped_source_classes with the reason it does not apply.`);
  }
  return { ok: true, value: { goal: value.goal, questions, skipped } };
}

/** A draft as `submit_research_draft` takes it; the message names the field to correct. */
export function decodeResearchDraft(value: unknown): DecodedResearch<ResearchDraft> {
  if (!isRecord(value)) return refused("The arguments must be one object.");
  const limits = RESEARCH_LIMITS;
  if (!boundedText(value.report, limits.reportCharacters)) return refused(`report must be 1 to ${limits.reportCharacters} characters.`);
  if (!Array.isArray(value.findings) || value.findings.length > limits.findings) {
    return refused(`findings must list at most ${limits.findings} findings.`);
  }
  const findings: ResearchFinding[] = [];
  for (const [index, entry] of value.findings.entries()) {
    const at = `findings[${index}]`;
    if (!isRecord(entry)) return refused(`${at} must be one object.`);
    if (!boundedText(entry.claim, limits.claimCharacters)) return refused(`${at}.claim must be 1 to ${limits.claimCharacters} characters.`);
    if (!boundedText(entry.url, limits.urlCharacters)) return refused(`${at}.url must be the link of the source.`);
    if (!boundedText(entry.quote, limits.quoteCharacters)) return refused(`${at}.quote must be 1 to ${limits.quoteCharacters} characters copied from the source.`);
    if (!isResearchSourceClass(entry.source_class)) return refused(`${at}.source_class must be one of ${RESEARCH_SOURCE_CLASSES.join(", ")}.`);
    if (!(RESEARCH_STANDINGS as readonly unknown[]).includes(entry.standing)) return refused(`${at}.standing must be one of ${RESEARCH_STANDINGS.join(", ")}.`);
    findings.push({ claim: entry.claim, quote: entry.quote, sourceClass: entry.source_class, standing: entry.standing as ResearchStanding, url: entry.url });
  }
  if (!Array.isArray(value.unreachable) || value.unreachable.length > limits.unreachable) {
    return refused(`unreachable must list at most ${limits.unreachable} sources.`);
  }
  const unreachable: ResearchUnreachable[] = [];
  for (const [index, entry] of value.unreachable.entries()) {
    const at = `unreachable[${index}]`;
    if (!isRecord(entry) || !boundedText(entry.target, limits.targetCharacters) || !boundedText(entry.reason, limits.reasonCharacters)) {
      return refused(`${at} needs target (the source) and reason (why it could not be reached).`);
    }
    const sourceClass = entry.source_class ?? null;
    if (sourceClass !== null && !isResearchSourceClass(sourceClass)) return refused(`${at}.source_class must be one of ${RESEARCH_SOURCE_CLASSES.join(", ")} or null.`);
    unreachable.push({ reason: entry.reason, sourceClass, target: entry.target });
  }
  return { ok: true, value: { findings, origin: "reserved_call", report: value.report, unreachable } };
}
