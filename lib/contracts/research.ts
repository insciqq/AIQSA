/**
 * The research method's shapes (operator decisions 2026-11-01): a plan of
 * questions with source classes assigned up front, findings as claim, link,
 * verbatim quote and source class, a draft of the report, and what a gate says
 * of a draft. Research stays inside one run that ends in an ordinary answer.
 * Pure and bounded: the tools decode what a model sent with these.
 *
 * The research system's shapes live here too, so its parts build on one
 * contract: the plan proposal and the user's answer to it, the frame and its
 * matrix, an evidence record, a stored page, the time phases and the roles.
 * What the system does with them is in `agent_docs/RUN_CONTRACTS.md`, Research.
 *
 * A tool schema with `strict: true` fails with a 400 on every answer when a
 * property is optional, so a tool on these decoders lists every field as
 * required and gives one that does not apply as null. The decoders of the
 * system expect exactly that: a field that may not apply is required and
 * nullable, never optional. Keep it so when a field is added to a strict tool. The draft's
 * tool is not strict: its references also read a left-out field as one that does not apply,
 * and an edit submission may omit the summary to keep the previous one.
 */

export const START_RESEARCH_TOOL_NAME = "start_research";
export const SUBMIT_RESEARCH_DRAFT_TOOL_NAME = "submit_research_draft";
export const PROPOSE_RESEARCH_PLAN_TOOL_NAME = "propose_research_plan";
export const RECORD_EVIDENCE_TOOL_NAME = "record_evidence";
export const CHANGE_RESEARCH_FRAME_TOOL_NAME = "change_research_frame";

/**
 * The send field that asks for Deep research on one message (operator decision 2026-11-05): the `+` menu's Deep research item, and
 * nothing written in a chat, starts research. It goes at the top level of a send's JSON body (`POST /api/chats/:chatId/messages`) and
 * of the regenerate that runs an edited message (`POST /api/messages/:messageId/regenerate`), as `true` only; leave it out otherwise.
 * Admission freezes it with the run's bindings, and a regenerate without it keeps what the message was sent with.
 */
export const DEEP_RESEARCH_SEND_FIELD = "deepResearch";

/**
 * Why a send that asked for Deep research was refused, as the response's `error`: `invalid` (400) for a field that is not `true`;
 * `needsSearch` (409) for a message with no Search source, which Search turned on mends; `unavailable` (409) where research never
 * runs: Telegram, scheduled tasks and monitoring checks, or a run without tools. The message is never answered another way.
 */
export const DEEP_RESEARCH_REFUSALS = Object.freeze({
  invalid: "deep_research_invalid",
  needsSearch: "deep_research_needs_search",
  unavailable: "deep_research_unavailable"
} as const);

/** The send field's value: true when Deep research was asked for, null when it was not, and "invalid" for anything but `true`. */
export function decodeDeepResearchRequest(value: unknown): true | null | "invalid" {
  if (value === undefined) return null;
  return value === true ? true : "invalid";
}

/** Where a claim's evidence comes from. Each class is assigned, or skipped with a reason, before anyone searches. */
export const RESEARCH_SOURCE_CLASSES = ["primary_official", "independent_tests", "owner_reviews", "action_channel"] as const;
export type ResearchSourceClass = (typeof RESEARCH_SOURCE_CLASSES)[number];

/** What a report may say of a claim: it keeps these three apart. */
export const RESEARCH_STANDINGS = ["confirmed", "claimed", "not_verified"] as const;
export type ResearchStanding = (typeof RESEARCH_STANDINGS)[number];

/** The roles an administrator binds: researchers, and the checks (gap judge, verifier, skeptic). The main agent stays on the chat's model. */
export const RESEARCH_ROLES = ["researcher", "checks"] as const;
export type ResearchRole = (typeof RESEARCH_ROLES)[number];

export const RESEARCH_LIMITS = Object.freeze({
  claimCharacters: 2_000,
  draftEditCharacters: 20_000,
  draftEdits: 32,
  draftEditsCharacters: 200_000,
  findings: 300,
  goalCharacters: 2_000,
  /** One sentence on how the pick does on one of the user's priorities (`ResearchPriorityAnswer`), and the records it rests on. */
  priorityAnswerCharacters: 500,
  priorityAnswerRecords: 8,
  questionCharacters: 1_000,
  questions: 16,
  quoteCharacters: 4_000,
  reasonCharacters: 1_000,
  reportCharacters: 200_000,
  sitesPerQuestion: 8,
  siteCharacters: 256,
  /** A summary is two to four short paragraphs read before the report: past this it is no summary. */
  summaryCharacters: 4_000,
  targetCharacters: 512,
  unreachable: 64,
  urlCharacters: 2_048
});

export const RESEARCH_PLAN_LIMITS = Object.freeze({
  assumptionCharacters: 300,
  assumptions: 12,
  stepCharacters: 240,
  stepsMax: 6,
  stepsMin: 4,
  understoodCharacters: 1_000,
  /** The steps a person's edit may leave: they may delete down to one, or add past what a model proposes. */
  userStepsMax: 12
});

/** Keys stay stable for the run: records, cells and picks refer to them whatever a label says. */
export const RESEARCH_FRAME_LIMITS = Object.freeze({
  branches: 8,
  /**
   * Notes of candidates in all, a further site's or agent's note of one included, and candidates noted: room for the pool round 1 builds from
   * several kinds of source (`lib/server/research/candidates.ts`). With one set-aside at most per candidate they and the matrix's own additions
   * (64 rows, 24 criteria, 8 branches) stay within `changes` (64 + 24 + 8 + 160 + 64 = 320), so no note can cost a row.
   */
  candidateNotes: 160,
  candidates: 64,
  casesPerBranch: 6,
  changes: 320,
  criteria: 24,
  /** Criteria a plan may mark decisive: the few a pick depends on, each of which every option the report recommends has confirmed on two sites. */
  decisiveCriteria: 4,
  labelCharacters: 200,
  /**
   * Criteria a plan may mark as priorities: only what the user's own message names as mattering, such as value for money, which then decides the pick
   * (operator decision 2026-11-05). A few, since the summary answers each in a line of its own.
   */
  priorityCriteria: 3,
  /** The one criterion that holds the options' public ratings and reviews (`ResearchCriterion.ratings`). */
  ratingsCriteria: 1,
  rows: 64,
  whyCharacters: 500
});

export const RESEARCH_EVIDENCE_LIMITS = Object.freeze({
  /** How far a reader walks `ResearchFrame.continuedFromRunId`: past this it stops reading, so it can never loop. */
  continuationChain: 8,
  datasetCounts: 16,
  datasetExamples: 8,
  methodCharacters: 2_000,
  /** The most ratings one rating may count, and the highest top of its scale (`ResearchRating`): a scale of 100 is the widest a public one uses. */
  ratingCount: 1_000_000_000,
  ratingScale: 100,
  /** At their longest these are about 12 MB, and no report rests on more. */
  recordsPerRun: 2_000,
  sampleSize: 1_000_000
});

/**
 * What the database and the operator's backups carry for one run's pages. `fetch_url` keeps at most 24 000 characters of a page, 48 KB of
 * Cyrillic, and 256 KiB also holds a marketplace card with its reviews as the browser prints it. 32 MiB is the 16 million characters of
 * Cyrillic one quote check already reads (`RESEARCH_SOURCE_LIMITS`). The database checks the bound per page as well.
 */
export const RESEARCH_PAGE_LIMITS = Object.freeze({
  bytesPerPage: 256 * 1024,
  bytesPerRun: 32 * 1024 * 1024,
  pagesPerRun: 400
});

const MINUTE_MS = 60_000;

/** The system's time limits in milliseconds (operator decisions 2026-11-01); nothing else restates these numbers. */
export const RESEARCH_TIME_MS = Object.freeze({
  /** How long an edit in progress holds the window before the last saved plan is released. */
  abandonedEdit: 5 * MINUTE_MS,
  /**
   * How long a run's end waits for the answer built from its records: a read of at most a run's records on one host and no model call,
   * so seconds at worst, and well inside the minute a turn keeps for its handoff (`TURN_HANDOFF_RESERVE_MS`).
   */
  composeReport: 15_000,
  /** From the plan's release: the hard end. */
  hardEnd: 90 * MINUTE_MS,
  /** From the plan's release: what did not pass by now goes out with a note. Report and checks run from `stopRunningResearchers` to here. */
  notes: 85 * MINUTE_MS,
  /**
   * The page a finished research writes from its final report while the answer waits (operator decision 2026-11-05, `lib/server/research/page.ts`):
   * one response that writes it, its call and the one send back of its check. It starts only when the hard end, less the turn's handoff reserve, still
   * leaves this much, and it never moves the hard end: past it the answer goes out without a page.
   */
  page: 8 * MINUTE_MS,
  planWindow: 60_000,
  /** One researcher's turn, so one stuck agent cannot spend the whole budget. */
  researcherTurn: 25 * MINUTE_MS,
  scoping: 3 * MINUTE_MS,
  /** From the plan's release: running researchers are stopped, and what they recorded stays. */
  stopRunningResearchers: 70 * MINUTE_MS,
  /** From the plan's release: no new researcher, and running ones are told to finish. */
  stopStartingResearchers: 60 * MINUTE_MS
});

export const RESEARCH_ROUND_LIMITS = Object.freeze({
  /** Rounds in a row that fill no new cell before the report. */
  noNewCellRounds: 2,
  sendBacksPerCheck: 2
});

/**
 * One researcher's turn is one short task (operator-approved plan, 2026-11-03). On acceptance run 1 (2026-11-02) research took 51 of 61
 * minutes in two 25-minute rounds, both ended by the turn's time rather than by work done, and model responses took 87 of 120
 * researcher-minutes. `toolCalls`: the calls one turn may make, the upper end of Anthropic's published 5–15 per subagent; past them its
 * next round writes the report without tools. `record_evidence` and `change_research_frame` never count, so recording is never what a
 * spent budget discourages. `RESEARCH_TIME_MS.researcherTurn` stays the outer net.
 */
export const RESEARCH_TASK_LIMITS = Object.freeze({
  toolCalls: 15
});

/**
 * When a researcher's context sheds its oldest pages (`lib/server/engine/compaction/clearing.ts`), in tokens of the measured context.
 * Measured on nine runs of 2026-11-02: a research makes 200–350 researcher responses, each reading 85–120 thousand input tokens while a
 * researcher's first reads about 14 thousand, because every page it opened stayed in its context.
 *
 * The marks are the shape of the documented default of Anthropic's context editing, which clears past 100,000 input tokens and keeps the
 * newest 3 tool results, here every older page in one step, so a clearing costs one miss of the provider's prompt cache (2026-11-03). They
 * replace a planning guess of 60,000 down to 25,000, which did not hold: on acceptance run 1 (2026-11-02) a researcher's responses still
 * read 80–100 thousand tokens, and most of that floor was the thread's replayed reasoning and its calls' arguments, which clearing never
 * removes. Short tasks keep a thread small (`RESEARCH_TASK_LIMITS`); this is the safety net for a long one.
 */
export const RESEARCHER_CONTEXT_CLEARING = Object.freeze({
  /** Past this the oldest page results become stubs that name their handle. */
  clearAboveTokens: 100_000,
  /** Less than this to free and the clearing waits, since each clearing costs one miss of the provider's prompt cache. */
  clearAtLeastTokens: 10_000,
  /** Nothing but the newest pages stays: every older one becomes a stub in the same step. */
  clearToTokens: 0,
  /** The newest page results, which stay whole: a researcher records from the page it has just read. */
  keepRecentResults: 3
});

/** Where a research run stands. The first two come before the plan's release; `researchPhaseAt` gives the rest. */
export const RESEARCH_PHASES = ["scoping", "plan_window", "researching", "winding_down", "reporting", "notes", "ended"] as const;
export type ResearchPhase = (typeof RESEARCH_PHASES)[number];

/** The phase this long after the plan's release. */
export function researchPhaseAt(sinceReleaseMs: number): ResearchPhase {
  const time = RESEARCH_TIME_MS;
  if (sinceReleaseMs >= time.hardEnd) return "ended";
  if (sinceReleaseMs >= time.notes) return "notes";
  if (sinceReleaseMs >= time.stopRunningResearchers) return "reporting";
  if (sinceReleaseMs >= time.stopStartingResearchers) return "winding_down";
  return "researching";
}

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

/** What `start_research` takes once the plan window is live: only the goal, which opens scoping. */
export type ResearchStart = Readonly<{ goal: string }>;

/**
 * A column of the matrix, with why it matters in plain words. For a knowledge question it is an outcome or a sub-question. `decisive`: a key specification, a
 * property of the option itself that a pick depends on and sellers may state differently, such as a mattress's load per side. `priority`: what the user's own
 * message names as mattering, such as value for money, which decides the pick (operator decision 2026-11-05). `ratings`: the column of the options' public
 * ratings and reviews, whose cells hold each option's rating records (operator decision 2026-11-05: ratings count, for products and services alike). Each is
 * present only when true, so a frame stored before it, and a criterion added on the way, have none.
 */
export type ResearchCriterion = Readonly<{ criterion: string; decisive?: true; key: string; priority?: true; ratings?: true; why: string }>;

/**
 * Whether the user chooses among options: the plan marked key specifications or the user's priorities. A knowledge question has neither. The report check asks such
 * a draft for a pick, and the frame of such a plan holds a ratings criterion (`researchFrameFromPlan`).
 */
export const researchChoosesAmongOptions = (criteria: readonly ResearchCriterion[]): boolean =>
  criteria.some((criterion) => criterion.decisive === true || criterion.priority === true);

/** A row of the matrix: an option the user could choose. */
export type ResearchMatrixRow = Readonly<{ key: string; label: string }>;

export type ResearchBranchCase = Readonly<{ key: string; label: string }>;

/** What is unknown about the user and changes the result (`unknown`), and the cases a report splits by: "up to 70 kg, A; heavier, B". */
export type ResearchBranch = Readonly<{ cases: readonly ResearchBranchCase[]; key: string; unknown: string }>;

/** Who wrote a record or changed the frame: a sub-agent's thread, or both null for the main agent. */
export type ResearchAgentRef = Readonly<{ name: string | null; threadId: string | null }>;

/** What changes the matrix itself: each is logged in `ResearchFrame.changes`. */
const RESEARCH_MATRIX_CHANGES = ["add_branch", "add_criterion", "add_row"] as const;

/**
 * What `change_research_frame` takes: the matrix's own changes, and the candidates beside it. `note_candidate`: any agent names an option it saw
 * that the matrix may lack, since on a real run a researcher saw whole the option a better answer picked, made no row of it, and nobody named it again.
 * `set_aside`: the main agent decides a noted one is no option, with its reason. Neither changes the matrix, so neither is in its log.
 */
export const RESEARCH_FRAME_CHANGES = [...RESEARCH_MATRIX_CHANGES, "note_candidate", "set_aside"] as const;
export type ResearchFrameChangeKind = (typeof RESEARCH_FRAME_CHANGES)[number];

/** One entry of the frame's change log; a report names added criteria with their reasons from here. */
export type ResearchFrameChange = Readonly<{ at: string; by: ResearchAgentRef; change: (typeof RESEARCH_MATRIX_CHANGES)[number]; key: string; reason: string }>;

/** A change an agent asks for (`change_research_frame`); the server stamps who and when. A candidate's key is the server's to make from its label. */
export type ResearchFrameChangeRequest = Readonly<{ reason: string }> & (
  | Readonly<{ branch: ResearchBranch; change: "add_branch" }>
  | Readonly<{ change: "add_criterion"; criterion: ResearchCriterion }>
  | Readonly<{ change: "add_row"; row: ResearchMatrixRow }>
  | Readonly<{ change: "note_candidate"; label: string; url?: string }>
  | Readonly<{ change: "set_aside"; key: string }>
);

/**
 * One agent's note of a candidate: who, when, and where it was seen and why it may be an option. `url` is the page that names it, absent on a note
 * that gave none and on one stored before the field: such a note counts its agent and no site.
 */
export type ResearchCandidateNote = Readonly<{ at: string; by: ResearchAgentRef; reason: string; url?: string }>;

/**
 * An option an agent saw that the matrix may lack, with one note per agent that noted it and per further site that agent saw it on. `key` is the
 * server's normal form of the name (`lib/server/research/candidates.ts`), which merges one option written two ways; `label` is the name as the first
 * agent wrote it.
 */
export type ResearchCandidate = Readonly<{ key: string; label: string; notes: readonly ResearchCandidateNote[] }>;

/** A noted candidate the main agent decided is no option, and why: the report keeps it with the options it does not recommend. */
export type ResearchSetAside = Readonly<{ at: string; key: string; reason: string }>;

/**
 * The matrix of a run with its change log, as `ResearchFrame.frame` keeps it. It only grows while the run lives. `candidates` and `setAside` are
 * absent on a frame stored before them, which reads as none noted.
 */
export type ResearchFrame = Readonly<{
  branches: readonly ResearchBranch[];
  candidates?: readonly ResearchCandidate[];
  changes: readonly ResearchFrameChange[];
  criteria: readonly ResearchCriterion[];
  rows: readonly ResearchMatrixRow[];
  setAside?: readonly ResearchSetAside[];
}>;

/**
 * What `propose_research_plan` shows the user: how the task was understood, what is assumed in place of a question (operator
 * decision 2026-11-01: no clarifying questions), the short steps, and the criteria with why each matters. The questions and classes
 * are the plan the method runs on. `rows` and `branches` may be empty: researchers add rows, and a report may need no branch.
 */
export type ResearchPlanProposal = Readonly<{
  assumptions: readonly string[];
  branches: readonly ResearchBranch[];
  criteria: readonly ResearchCriterion[];
  questions: readonly ResearchQuestion[];
  rows: readonly ResearchMatrixRow[];
  skipped: readonly ResearchSkippedClass[];
  steps: readonly string[];
  understood: string;
}>;

/** What a person can change of a proposal in the widget. */
export type ResearchPlanEdit = Pick<ResearchPlanProposal, "assumptions" | "steps" | "understood">;

/** What closed the plan window. A `chat_message` is an edit whose words reach the model as a follow-up. */
export const RESEARCH_PLAN_RELEASES = ["timer", "start_button", "saved_edit", "chat_message", "abandoned_edit"] as const;
export type ResearchPlanRelease = (typeof RESEARCH_PLAN_RELEASES)[number];

/** The user's answer to a proposal: what closed the window, the plan that stands, and whether they changed it. */
export type ResearchPlanAnswer = Readonly<{
  changed: boolean;
  plan: ResearchPlanProposal;
  releasedBy: ResearchPlanRelease;
}>;

/** What the widget asks of a window (`app/api/chats/[chatId]/research/plan/route.ts`): the button, a lease while editing, its end, and a saved edit. */
export const RESEARCH_PLAN_ACTIONS = ["cancel_hold", "hold", "save", "start"] as const;
export type ResearchPlanAction =
  | Readonly<{ action: "cancel_hold" | "hold" | "start"; runId: string }>
  | Readonly<{ action: "save"; edit: ResearchPlanEdit; runId: string }>;

/**
 * What the browser reads of a window. Every time is the server's: the widget counts `windowEndsAt` from `serverTime`, so the countdown
 * survives a reload, a background tab and a wrong client clock. `heldUntil` is set while an edit holds the timer; `answer` once it closed.
 */
export type ResearchPlanWindowView = Readonly<{
  answer: ResearchPlanAnswer | null;
  heldUntil: string | null;
  proposal: ResearchPlanProposal;
  runId: string;
  serverTime: string;
  windowEndsAt: string;
}>;

export type ResearchFinding = Readonly<{
  claim: string;
  /** Copied verbatim from the page an agent opened. */
  quote: string;
  /** The evidence record it stands for, which only the server sets. Absent on a finding typed into a draft stored before drafts referred to records. */
  recordId?: string;
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

/**
 * What an evidence record is. `finding`: a claim with its link and verbatim quote. `not_found`: nothing was found for a cell, which
 * counts as filled. `dataset`: what a script collected, with its method, sample and examples. `unreachable`: a site and why.
 */
export const RESEARCH_RECORD_KINDS = ["finding", "not_found", "dataset", "unreachable"] as const;
export type ResearchRecordKind = (typeof RESEARCH_RECORD_KINDS)[number];

export type ResearchDatasetCount = Readonly<{ count: number; label: string }>;
export type ResearchDatasetExample = Readonly<{ quote: string; url: string }>;

/** How a dataset was made, so a verifier can check it and a small sample is never read as a rate. */
export type ResearchDataset = Readonly<{
  counts: readonly ResearchDatasetCount[];
  examples: readonly ResearchDatasetExample[];
  leftOut: string;
  method: string;
  sampleSize: number;
}>;

/** What a rating's number counts: ratings given, written reviews, or buyers who rated. */
export const RESEARCH_RATING_COUNTS = ["ratings", "reviews", "buyers"] as const;
export type ResearchRatingCounted = (typeof RESEARCH_RATING_COUNTS)[number];

/**
 * A public rating of one option, a product's or a service's such as a doctor's, as a finding carries it (operator decision 2026-11-05): a real person looks at the
 * score and the number of ratings first. Its platform is the site of the finding's link and its date the record's, so neither is typed in. Its score and count stand
 * in the finding's quote as the page writes them, which the store checks (`lib/server/research/evidenceStore.ts`). `variantsMerged`: the card merges the ratings of
 * the option's variants, such as sizes or versions, so the score is not this exact option's alone.
 */
export type ResearchRating = Readonly<{ count: number; counted: ResearchRatingCounted; scaleMax: number; score: number; variantsMerged: boolean }>;

/** A record as an agent hands it in. `supersedes` names the record it corrects: nothing is changed or deleted while the run lives. */
export type ResearchRecordInput = Readonly<{ criterionKey: string | null; rowKey: string | null; supersedes: string | null }> & (
  /** `rating` only on a finding of a public rating, and absent on every other one and on one stored before the field. */
  | Readonly<{ claim: string; kind: "finding"; quote: string; rating?: ResearchRating; sourceClass: ResearchSourceClass; standing: ResearchStanding; url: string }>
  | Readonly<{ criterionKey: string; kind: "not_found"; reason: string; rowKey: string; sourceClass: ResearchSourceClass | null }>
  | Readonly<{ claim: string; dataset: ResearchDataset; kind: "dataset"; rowKey: string; sourceClass: ResearchSourceClass; standing: ResearchStanding; url: string }>
  | Readonly<{ kind: "unreachable"; reason: string; sourceClass: ResearchSourceClass | null; target: string }>
);

/** The quote check's result when the record was written (`lib/server/research/quoteCheck.ts`). */
export const RESEARCH_QUOTE_CHECKS = ["found", "not_verbatim", "not_checked", "unsupported"] as const;
export type ResearchQuoteCheckStatus = (typeof RESEARCH_QUOTE_CHECKS)[number];

/** A record as the store keeps it: the agent's fields, and what only the server writes. */
export type ResearchEvidenceRecord = ResearchRecordInput & Readonly<{
  author: ResearchAgentRef;
  createdAt: string;
  id: string;
  /** The stored page the quote was checked on; null when none could be kept. */
  pageId: string | null;
  /** The page's own date as exact as it gives one: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
  publishedOn: string | null;
  quoteCheck: Readonly<{ reason: string | null; status: ResearchQuoteCheckStatus }> | null;
  /** From the link, so two pages of one site are one source. */
  registrableDomain: string | null;
  runId: string;
  /** Run-scoped and stable, so every reader sees one order. */
  sequence: number;
  /** Equal for near-identical text across domains, so copies of one press release are one source. */
  textGroupKey: string | null;
}>;

export const RESEARCH_PAGE_ORIGINS = ["tool", "browser"] as const;
export type ResearchPageOrigin = (typeof RESEARCH_PAGE_ORIGINS)[number];

/** The text an agent saw, kept by the server and never written by an agent. `truncated`: the page was over the bound, and a quote past it is no failure. */
export type ResearchStoredPage = Readonly<{
  capturedAt: string;
  contentHash: string;
  id: string;
  obtainedBy: ResearchPageOrigin;
  sizeBytes: number;
  text: string;
  truncated: boolean;
  url: string;
}>;

/** `not_found` counts as filled: a cell recorded as nothing found is not researched again. */
export const RESEARCH_CELL_STATES = ["empty", "filled", "not_found"] as const;
export type ResearchCellState = (typeof RESEARCH_CELL_STATES)[number];

export type ResearchMatrixCell = Readonly<{ criterionKey: string; recordIds: readonly string[]; rowKey: string; state: ResearchCellState }>;

/** The matrix against the live records: what each round is planned from. */
export type ResearchMatrixCoverage = Readonly<{ cells: readonly ResearchMatrixCell[]; empty: number; filled: number }>;

/** The rows a draft picks for one case of what is unknown about the user. */
export type ResearchBranchPick = Readonly<{ branchKey: string; caseKey: string; rowKey: string }>;

/** The report's statement that the data does not tell these rows apart, and what would decide. */
export type ResearchNoSeparation = Readonly<{ rowKeys: readonly string[]; statement: string; wouldDecide: string }>;

/** What ties a draft to the records and the matrix (`decodeResearchDraftReferences`). */
export type ResearchDraftReferences = Readonly<{
  branchPicks: readonly ResearchBranchPick[];
  doesNotSeparate: ResearchNoSeparation | null;
  pickRowKey: string | null;
  /** The records its factual claims rest on; advice needs none. */
  recordIds: readonly string[];
}>;

/** One sentence on how the pick does on a priority the plan marked, against the next option the summary recommends, and the records it rests on. */
export type ResearchPriorityAnswer = Readonly<{ criterionKey: string; recordIds: readonly string[]; text: string }>;

/**
 * What the user reads first, which the server puts above the report (operator decision 2026-11-02: most readers stop there). `rowKeys` are the
 * rows it recommends in its order, the pick first, so the checks can hold its words to the matrix. `priorities` answer what the user named as mattering,
 * each in a line right under the text (operator decision 2026-11-05); absent where it answers none, as on a summary stored before them.
 */
export type ResearchDraftSummary = Readonly<{ priorities?: readonly ResearchPriorityAnswer[]; rowKeys: readonly string[]; text: string }>;

/**
 * The references are there on a draft that refers to records, and absent on a text draft or one stored from before. `findings` are what
 * every gate reads: a model types none, and the server fills them from the records its ids name (`researchDraftWithRecords`).
 */
export type ResearchDraft = Partial<ResearchDraftReferences> & Readonly<{
  findings: readonly ResearchFinding[];
  /** What is wrong with references that could not be read: the report stands, and the report check sends it back with this. */
  invalidReferences?: string;
  /** What is wrong with a summary that could not be read whole: what of it could be read stands, and the report check sends it back with this. */
  invalidSummary?: string;
  /**
   * `reserved_call`: the model called `submit_research_draft`. `plain_text`: it wrote a final message instead, twice
   * or with its tools closed, so the draft has its text and no findings.
   */
  origin: "plain_text" | "reserved_call";
  /** The report as the user will read it, below the summary: an accepted draft is published as it is, with no further model call. */
  report: string;
  /**
   * Null when the call passed none, which the report check sends back; a draft stored with record_ids from before summaries reads so too, which is harmless,
   * since only the draft being checked is sent back and a stored one is only read. Absent on a draft with typed findings, stored before records.
   */
  summary?: ResearchDraftSummary | null;
  unreachable: readonly ResearchUnreachable[];
}>;

/**
 * The summary as its reader reads it: its text, then a line for each priority it answers, right under it, so the answers stay part of the summary. No words
 * of the server's own: each line is the model's sentence, kept to one line.
 */
export function researchSummaryText(summary: ResearchDraftSummary): string {
  const lines = (summary.priorities ?? []).map(({ text }) => `- ${text.replace(/\s+/gu, " ").trim()}`);
  return lines.length > 0 ? `${summary.text.trim()}\n\n${lines.join("\n")}` : summary.text.trim();
}

/** The answer's text of a draft: its summary above the report, as the server places it, with no words of the server's own between them. */
export function researchDraftText(draft: Pick<ResearchDraft, "report" | "summary">): string {
  return draft.summary ? `${researchSummaryText(draft.summary)}\n\n${draft.report}` : draft.report;
}

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

/** Text PostgreSQL can hold: neither `text` nor `jsonb` takes a NUL. */
const storableText = (value: unknown, max: number): value is string => boundedText(value, max) && !value.includes("\u0000");

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => (list as readonly unknown[]).includes(value);

export const isResearchSourceClass = (value: unknown): value is ResearchSourceClass =>
  (RESEARCH_SOURCE_CLASSES as readonly unknown[]).includes(value);

/** A matrix key: stable across a run, plain enough for a model to copy and for a column bound of 48. */
const RESEARCH_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/u;
const KEY_RULE = "1 to 48 lowercase letters, digits, - or _, starting with a letter or digit";
const isResearchKey = (value: unknown): value is string => typeof value === "string" && RESEARCH_KEY_PATTERN.test(value);

const RECORD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const isRecordId = (value: unknown): value is string => typeof value === "string" && RECORD_ID_PATTERN.test(value);
/** What a draft may name as a record, any short text: one that is no id goes back through the report check, which says which, like any other that names no record. */
const isCitedRecord = (value: unknown): value is string => storableText(value, 64);

const isLink = (value: unknown): value is string => storableText(value, RESEARCH_LIMITS.urlCharacters) && /^https?:\/\//iu.test(value);

const isTimestamp = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));

const refused = (message: string) => ({ message, ok: false as const });

/** A field's place in a message: `criteria[2].key`, or `key` in a flat object. */
const fieldAt = (place: string, field: string) => place ? `${place}.${field}` : field;

/** Every listed field must be there, null when it does not apply: what a strict tool schema always sends. */
function missingField(value: Readonly<Record<string, unknown>>, fields: readonly string[]): string | null {
  const missing = fields.find((field) => value[field] === undefined);
  return missing === undefined ? null : `${missing} must be given: pass null when it does not apply.`;
}

/** The questions and skipped classes of a plan or a proposal: every class assigned or skipped with its reason. */
function decodeQuestionPlan(value: Readonly<Record<string, unknown>>): DecodedResearch<Pick<ResearchPlan, "questions" | "skipped">> {
  const limits = RESEARCH_LIMITS;
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
  return { ok: true, value: { questions, skipped } };
}

/** A plan as `start_research` takes it; the message names the field to correct. */
export function decodeResearchPlan(value: unknown): DecodedResearch<ResearchPlan> {
  if (!isRecord(value)) return refused("The arguments must be one object.");
  if (!boundedText(value.goal, RESEARCH_LIMITS.goalCharacters)) return refused(`goal must be 1 to ${RESEARCH_LIMITS.goalCharacters} characters.`);
  const decoded = decodeQuestionPlan(value);
  return decoded.ok ? { ok: true, value: { goal: value.goal, ...decoded.value } } : decoded;
}

/** A goal as `start_research` takes it once the plan window is live: nothing else, and the plan comes from `propose_research_plan`. */
export function decodeResearchStart(value: unknown): DecodedResearch<ResearchStart> {
  if (!isRecord(value)) return refused("The arguments must be one object.");
  if (!storableText(value.goal, RESEARCH_LIMITS.goalCharacters)) return refused(`goal must be 1 to ${RESEARCH_LIMITS.goalCharacters} characters.`);
  return { ok: true, value: { goal: value.goal } };
}

type ListBounds = Readonly<{ max: number; min: number }>;

function decodeTexts(value: unknown, field: string, bounds: ListBounds, characters: number): DecodedResearch<readonly string[]> {
  if (!Array.isArray(value) || value.length < bounds.min || value.length > bounds.max) return refused(`${field} must list ${bounds.min} to ${bounds.max} entries.`);
  for (const [index, entry] of value.entries()) {
    if (!storableText(entry, characters)) return refused(`${field}[${index}] must be 1 to ${characters} characters.`);
  }
  return { ok: true, value: value as string[] };
}

/** A list whose entries carry keys: each decoded by `decodeEntry`, no key twice. */
function decodeKeyed<T extends Readonly<{ key: string }>>(value: unknown, field: string, bounds: ListBounds,
  decodeEntry: (entry: unknown, place: string) => DecodedResearch<T>): DecodedResearch<readonly T[]> {
  if (!Array.isArray(value) || value.length < bounds.min || value.length > bounds.max) return refused(`${field} must list ${bounds.min} to ${bounds.max} entries.`);
  const entries: T[] = [];
  for (const [index, entry] of value.entries()) {
    const place = `${field}[${index}]`;
    const decoded = decodeEntry(entry, place);
    if (!decoded.ok) return decoded;
    if (entries.some((earlier) => earlier.key === decoded.value.key)) return refused(`${place}.key repeats an earlier key.`);
    entries.push(decoded.value);
  }
  return { ok: true, value: entries };
}

function decodeRow(entry: unknown, place: string): DecodedResearch<ResearchMatrixRow> {
  const limits = RESEARCH_FRAME_LIMITS;
  if (!isRecord(entry)) return refused(`${place} must be one object.`);
  if (!isResearchKey(entry.key)) return refused(`${fieldAt(place, "key")} must be ${KEY_RULE}.`);
  if (!storableText(entry.label, limits.labelCharacters)) return refused(`${fieldAt(place, "label")} must be 1 to ${limits.labelCharacters} characters.`);
  return { ok: true, value: { key: entry.key, label: entry.label } };
}

function decodeCriterion(entry: unknown, place: string): DecodedResearch<ResearchCriterion> {
  const limits = RESEARCH_FRAME_LIMITS;
  if (!isRecord(entry)) return refused(`${place} must be one object.`);
  if (!isResearchKey(entry.key)) return refused(`${fieldAt(place, "key")} must be ${KEY_RULE}.`);
  if (!storableText(entry.criterion, limits.labelCharacters)) return refused(`${fieldAt(place, "criterion")} must be 1 to ${limits.labelCharacters} characters.`);
  if (!storableText(entry.why, limits.whyCharacters)) return refused(`${fieldAt(place, "why")} must say in 1 to ${limits.whyCharacters} characters why this criterion matters.`);
  // Left out or null reads as false: a frame or proposal stored before the field has none.
  for (const flag of ["decisive", "priority", "ratings"] as const) {
    if (entry[flag] !== undefined && entry[flag] !== null && typeof entry[flag] !== "boolean") return refused(`${fieldAt(place, flag)} must be true or false.`);
  }
  return { ok: true, value: { criterion: entry.criterion, ...entry.decisive === true ? { decisive: true as const } : {}, key: entry.key,
    ...entry.priority === true ? { priority: true as const } : {}, ...entry.ratings === true ? { ratings: true as const } : {}, why: entry.why } };
}

function decodeBranch(entry: unknown, place: string): DecodedResearch<ResearchBranch> {
  const limits = RESEARCH_FRAME_LIMITS;
  if (!isRecord(entry)) return refused(`${place} must be one object.`);
  if (!isResearchKey(entry.key)) return refused(`${fieldAt(place, "key")} must be ${KEY_RULE}.`);
  if (!storableText(entry.unknown, limits.labelCharacters)) return refused(`${fieldAt(place, "unknown")} must name in 1 to ${limits.labelCharacters} characters what is unknown about the user.`);
  const cases = decodeKeyed(entry.cases, fieldAt(place, "cases"), { max: limits.casesPerBranch, min: 2 }, decodeRow);
  return cases.ok ? { ok: true, value: { cases: cases.value, key: entry.key, unknown: entry.unknown } } : cases;
}

/** A proposal under the given bound on steps: a model's, or what a person's edit left. */
function decodeProposal(value: unknown, steps: ListBounds): DecodedResearch<ResearchPlanProposal> {
  if (!isRecord(value)) return refused("The arguments must be one object.");
  const limits = RESEARCH_PLAN_LIMITS;
  const frame = RESEARCH_FRAME_LIMITS;
  if (!storableText(value.understood, limits.understoodCharacters)) return refused(`understood must say in 1 to ${limits.understoodCharacters} characters how you understood the task.`);
  const assumptions = decodeTexts(value.assumptions, "assumptions", { max: limits.assumptions, min: 0 }, limits.assumptionCharacters);
  if (!assumptions.ok) return assumptions;
  const decodedSteps = decodeTexts(value.steps, "steps", steps, limits.stepCharacters);
  if (!decodedSteps.ok) return decodedSteps;
  const criteria = decodeKeyed(value.criteria, "criteria", { max: frame.criteria, min: 1 }, decodeCriterion);
  if (!criteria.ok) return criteria;
  if (criteria.value.filter(({ decisive }) => decisive).length > frame.decisiveCriteria) {
    return refused(`criteria marks more than ${frame.decisiveCriteria} as decisive: mark only the key specifications a pick depends on.`);
  }
  if (criteria.value.filter(({ priority }) => priority).length > frame.priorityCriteria) {
    return refused(`criteria marks more than ${frame.priorityCriteria} as priorities: mark only what the user's own message names as mattering to them.`);
  }
  if (criteria.value.filter(({ ratings }) => ratings).length > frame.ratingsCriteria) {
    return refused(`criteria marks more than ${frame.ratingsCriteria} as ratings: one criterion holds the options' public ratings and reviews.`);
  }
  const rows = decodeKeyed(value.rows, "rows", { max: frame.rows, min: 0 }, decodeRow);
  if (!rows.ok) return rows;
  const branches = decodeKeyed(value.branches, "branches", { max: frame.branches, min: 0 }, decodeBranch);
  if (!branches.ok) return branches;
  const plan = decodeQuestionPlan(value);
  if (!plan.ok) return plan;
  const proposal = { assumptions: assumptions.value, branches: branches.value, criteria: criteria.value, questions: plan.value.questions, rows: rows.value,
    skipped: plan.value.skipped, steps: decodedSteps.value, understood: value.understood };
  // The questions share `decodeResearchPlan`'s text rule; a proposal is kept in `jsonb`.
  return JSON.stringify(proposal).includes("\\u0000") ? refused("The proposal must not hold a NUL character.") : { ok: true, value: proposal };
}

/** A proposal as `propose_research_plan` takes it, or as `researchPlanProposalDocument` keeps it; the message names the field to correct. */
export function decodeResearchPlanProposal(value: unknown): DecodedResearch<ResearchPlanProposal> {
  return decodeProposal(value, { max: RESEARCH_PLAN_LIMITS.stepsMax, min: RESEARCH_PLAN_LIMITS.stepsMin });
}

/** A proposal in the form its tool takes, which is how a row keeps it: one decoder reads both. */
export function researchPlanProposalDocument(proposal: ResearchPlanProposal) {
  return {
    assumptions: proposal.assumptions,
    branches: proposal.branches,
    criteria: proposal.criteria,
    questions: proposal.questions.map((entry) => ({ question: entry.question, sites: entry.sites, source_classes: entry.sourceClasses })),
    rows: proposal.rows,
    skipped_source_classes: proposal.skipped.map((entry) => ({ reason: entry.reason, source_class: entry.sourceClass })),
    steps: proposal.steps,
    understood: proposal.understood
  };
}

/** What the browser sends when a person saves an edit: every field, as the widget shows them. */
export function decodeResearchPlanEdit(value: unknown): DecodedResearch<ResearchPlanEdit> {
  if (!isRecord(value)) return refused("The edit must be one object.");
  const limits = RESEARCH_PLAN_LIMITS;
  if (!storableText(value.understood, limits.understoodCharacters)) return refused(`understood must be 1 to ${limits.understoodCharacters} characters.`);
  const assumptions = decodeTexts(value.assumptions, "assumptions", { max: limits.assumptions, min: 0 }, limits.assumptionCharacters);
  if (!assumptions.ok) return assumptions;
  const steps = decodeTexts(value.steps, "steps", { max: limits.userStepsMax, min: 1 }, limits.stepCharacters);
  if (!steps.ok) return steps;
  return { ok: true, value: { assumptions: assumptions.value, steps: steps.value, understood: value.understood } };
}

/** A proposal under a person's edit, and whether that changed anything. */
export function researchPlanWithEdit(proposal: ResearchPlanProposal, edit: ResearchPlanEdit): Readonly<{ changed: boolean; plan: ResearchPlanProposal }> {
  const same = (one: readonly string[], other: readonly string[]) => one.length === other.length && one.every((entry, index) => entry === other[index]);
  return { changed: proposal.understood !== edit.understood || !same(proposal.steps, edit.steps) || !same(proposal.assumptions, edit.assumptions),
    plan: { ...proposal, ...edit } };
}

/** What the browser asks of a window; the message names the field to correct. */
export function decodeResearchPlanAction(value: unknown): DecodedResearch<ResearchPlanAction> {
  if (!isRecord(value)) return refused("The request must be one object.");
  if (!storableText(value.runId, 64)) return refused("runId must name the run.");
  if (!isOneOf(RESEARCH_PLAN_ACTIONS, value.action)) return refused(`action must be one of ${RESEARCH_PLAN_ACTIONS.join(", ")}.`);
  if (value.action !== "save") return { ok: true, value: { action: value.action, runId: value.runId } };
  const edit = decodeResearchPlanEdit(value.plan);
  return edit.ok ? { ok: true, value: { action: "save", edit: edit.value, runId: value.runId } } : refused(`plan: ${edit.message}`);
}

/** An answer as `ResearchFrame.answer` keeps it (`researchPlanAnswerDocument`). The server writes `changed` and `released_by`; no browser claim reaches them. */
export function decodeResearchPlanAnswer(value: unknown): DecodedResearch<ResearchPlanAnswer> {
  if (!isRecord(value)) return refused("The answer must be one object.");
  if (!isOneOf(RESEARCH_PLAN_RELEASES, value.released_by)) return refused(`released_by must be one of ${RESEARCH_PLAN_RELEASES.join(", ")}.`);
  if (typeof value.changed !== "boolean") return refused("changed must say whether the user changed the plan.");
  const plan = decodeProposal(value.plan, { max: RESEARCH_PLAN_LIMITS.userStepsMax, min: 1 });
  if (!plan.ok) return refused(`plan: ${plan.message}`);
  return { ok: true, value: { changed: value.changed, plan: plan.value, releasedBy: value.released_by } };
}

export function researchPlanAnswerDocument(answer: ResearchPlanAnswer) {
  return { changed: answer.changed, plan: researchPlanProposalDocument(answer.plan), released_by: answer.releasedBy };
}

/** The plan the method's gates read, from the goal and the proposal that stands. */
export function researchPlanFromProposal(goal: string, proposal: ResearchPlanProposal): ResearchPlan {
  return { goal, questions: proposal.questions, skipped: proposal.skipped };
}

/** The words of the ratings criterion the server adds, in the research languages. */
const RATINGS_CRITERION_WORDS = Object.freeze({
  en: { criterion: "Ratings and reviews", why: "How many people rated each option and how: a score from many ratings says more than a few reviews." },
  es: { criterion: "Valoraciones y reseñas", why: "Cuántas personas valoraron cada opción y cómo: una nota de muchas valoraciones dice más que unas pocas reseñas." },
  ru: { criterion: "Рейтинг и отзывы", why: "Сколько людей оценили каждый вариант и как: оценка по многим отзывам говорит больше, чем несколько отзывов." }
});

/** Spanish function words: two of them, or a letter only Spanish writes, mark a plan written in Spanish. */
const SPANISH_WORDS = /(?<!\p{L})(?:el|la|los|las|del|para|por|con|una|que|y|más|cómo|cuál|qué)(?!\p{L})/gu;

/** The language of the plan's words for the user: what it understood and its criteria, which it writes in the user's language. */
function planLanguage(plan: Pick<ResearchPlanProposal, "criteria" | "understood">): keyof typeof RATINGS_CRITERION_WORDS {
  const words = [plan.understood, ...plan.criteria.map(({ criterion }) => criterion)].join(" ").toLowerCase();
  if (/\p{Script=Cyrillic}/u.test(words)) return "ru";
  return /[ñ¿¡]/u.test(words) || (words.match(SPANISH_WORDS) ?? []).length >= 2 ? "es" : "en";
}

/**
 * The plan's criteria with a column for ratings and reviews where the user chooses among options (operator decision 2026-11-05): a real person looks at the
 * score and the number of ratings first, for a product and for a service such as a doctor, and on two reviewed runs a few shop reviews carried a pick while a
 * marketplace's thousands of ratings stayed out. A criterion the plan marked as ratings stands as the model wrote it; otherwise the server adds one in the
 * plan's language under a key no criterion has. A knowledge question gets none, and neither does a plan already holding all the criteria a frame may.
 */
function criteriaWithRatings(plan: ResearchPlanProposal): readonly ResearchCriterion[] {
  const { criteria } = plan;
  if (!researchChoosesAmongOptions(criteria) || criteria.some(({ ratings }) => ratings) || criteria.length >= RESEARCH_FRAME_LIMITS.criteria) return criteria;
  const taken = new Set(criteria.map(({ key }) => key));
  const key = ["ratings", ...Array.from({ length: RESEARCH_FRAME_LIMITS.criteria }, (_entry, index) => `ratings-${index + 2}`)].find((candidate) => !taken.has(candidate))!;
  return [...criteria, { ...RATINGS_CRITERION_WORDS[planLanguage(plan)], key, ratings: true as const }];
}

/** The frame a released plan opens with: the plan's matrix, with the ratings criterion a choice among options holds. */
export function researchFrameFromPlan(plan: ResearchPlanProposal): ResearchFrame {
  return { branches: plan.branches, changes: [], criteria: criteriaWithRatings(plan), rows: plan.rows };
}

function decodeAgentRef(value: unknown): ResearchAgentRef | null {
  if (!isRecord(value)) return null;
  const { name, threadId } = value;
  if (name === null && threadId === null) return { name, threadId };
  return storableText(name, 48) && storableText(threadId, 64) ? { name, threadId } : null;
}

function decodeFrameChange(value: unknown, place: string): DecodedResearch<ResearchFrameChange> {
  if (!isRecord(value)) return refused(`${place} must be one object.`);
  if (!isTimestamp(value.at)) return refused(`${place}.at must be a time.`);
  const by = decodeAgentRef(value.by);
  if (!by) return refused(`${place}.by must name the agent.`);
  if (!isOneOf(RESEARCH_MATRIX_CHANGES, value.change)) return refused(`${place}.change must be one of ${RESEARCH_MATRIX_CHANGES.join(", ")}.`);
  if (!isResearchKey(value.key)) return refused(`${place}.key must be ${KEY_RULE}.`);
  if (!storableText(value.reason, RESEARCH_LIMITS.reasonCharacters)) return refused(`${place}.reason must be 1 to ${RESEARCH_LIMITS.reasonCharacters} characters.`);
  return { ok: true, value: { at: value.at, by, change: value.change, key: value.key, reason: value.reason } };
}

/** A candidate's key, which the server makes from a label: no matrix key, since a name may be long and of any script. */
const isCandidateKey = (value: unknown): value is string => storableText(value, RESEARCH_FRAME_LIMITS.labelCharacters) && !/\s/u.test(value);

function decodeCandidate(value: unknown, place: string): DecodedResearch<ResearchCandidate> {
  const limits = RESEARCH_FRAME_LIMITS;
  if (!isRecord(value)) return refused(`${place} must be one object.`);
  if (!isCandidateKey(value.key)) return refused(`${place}.key must be 1 to ${limits.labelCharacters} characters without spaces.`);
  if (!storableText(value.label, limits.labelCharacters)) return refused(`${place}.label must be 1 to ${limits.labelCharacters} characters.`);
  if (!Array.isArray(value.notes) || value.notes.length < 1 || value.notes.length > limits.candidateNotes) return refused(`${place}.notes must list 1 to ${limits.candidateNotes} entries.`);
  const notes: ResearchCandidateNote[] = [];
  for (const [index, entry] of value.notes.entries()) {
    const at = `${place}.notes[${index}]`;
    if (!isRecord(entry) || !isTimestamp(entry.at)) return refused(`${at}.at must be a time.`);
    const by = decodeAgentRef(entry.by);
    if (!by) return refused(`${at}.by must name the agent.`);
    if (!storableText(entry.reason, RESEARCH_LIMITS.reasonCharacters)) return refused(`${at}.reason must be 1 to ${RESEARCH_LIMITS.reasonCharacters} characters.`);
    // Left out or null reads as no page: a note stored before the field has none.
    const url = entry.url;
    if (url !== undefined && url !== null && !isLink(url)) return refused(`${at}.url must be an http or https link of at most ${RESEARCH_LIMITS.urlCharacters} characters.`);
    notes.push({ at: entry.at, by, reason: entry.reason, ...isLink(url) ? { url } : {} });
  }
  return { ok: true, value: { key: value.key, label: value.label, notes } };
}

function decodeSetAside(value: unknown, place: string): DecodedResearch<ResearchSetAside> {
  if (!isRecord(value)) return refused(`${place} must be one object.`);
  if (!isTimestamp(value.at)) return refused(`${place}.at must be a time.`);
  if (!isCandidateKey(value.key)) return refused(`${place}.key must be 1 to ${RESEARCH_FRAME_LIMITS.labelCharacters} characters without spaces.`);
  if (!storableText(value.reason, RESEARCH_LIMITS.reasonCharacters)) return refused(`${place}.reason must be 1 to ${RESEARCH_LIMITS.reasonCharacters} characters.`);
  return { ok: true, value: { at: value.at, key: value.key, reason: value.reason } };
}

/** A frame as `ResearchFrame.frame` keeps it: it holds at least the plan's criteria. One stored before candidates reads as it was written, with none. */
export function decodeResearchFrame(value: unknown): DecodedResearch<ResearchFrame> {
  if (!isRecord(value)) return refused("The frame must be one object.");
  const limits = RESEARCH_FRAME_LIMITS;
  const criteria = decodeKeyed(value.criteria, "criteria", { max: limits.criteria, min: 1 }, decodeCriterion);
  if (!criteria.ok) return criteria;
  const rows = decodeKeyed(value.rows, "rows", { max: limits.rows, min: 0 }, decodeRow);
  if (!rows.ok) return rows;
  const branches = decodeKeyed(value.branches, "branches", { max: limits.branches, min: 0 }, decodeBranch);
  if (!branches.ok) return branches;
  if (!Array.isArray(value.changes) || value.changes.length > limits.changes) return refused(`changes must list at most ${limits.changes} entries.`);
  const changes: ResearchFrameChange[] = [];
  for (const [index, entry] of value.changes.entries()) {
    const change = decodeFrameChange(entry, `changes[${index}]`);
    if (!change.ok) return change;
    changes.push(change.value);
  }
  const candidates = value.candidates === undefined ? null : decodeKeyed(value.candidates, "candidates", { max: limits.candidates, min: 0 }, decodeCandidate);
  if (candidates && !candidates.ok) return candidates;
  const setAside = value.setAside === undefined ? null : decodeKeyed(value.setAside, "setAside", { max: limits.candidates, min: 0 }, decodeSetAside);
  if (setAside && !setAside.ok) return setAside;
  return { ok: true, value: { branches: branches.value, ...candidates ? { candidates: candidates.value } : {}, changes, criteria: criteria.value, rows: rows.value,
    ...setAside ? { setAside: setAside.value } : {} } };
}

const FRAME_CHANGE_FIELDS = ["cases", "change", "key", "label", "reason", "url", "why"] as const;

/**
 * A change of the frame as `change_research_frame` takes it: `label` is a row's name, a criterion, what is unknown or a candidate's name, `key` is unread for
 * a candidate noted and names the candidate set aside, `url` is the page that names a noted candidate and unread for any other change, and `why`, `cases`
 * and `url` are null where they do not apply.
 */
export function decodeResearchFrameChange(value: unknown): DecodedResearch<ResearchFrameChangeRequest> {
  if (!isRecord(value)) return refused("The arguments must be one object.");
  const missing = missingField(value, FRAME_CHANGE_FIELDS);
  if (missing) return refused(missing);
  if (!isOneOf(RESEARCH_FRAME_CHANGES, value.change)) return refused(`change must be one of ${RESEARCH_FRAME_CHANGES.join(", ")}.`);
  if (!storableText(value.reason, RESEARCH_LIMITS.reasonCharacters)) return refused(`reason must say in 1 to ${RESEARCH_LIMITS.reasonCharacters} characters why the frame changes.`);
  const reason = value.reason;
  if (value.change === "note_candidate") {
    if (!storableText(value.label, RESEARCH_FRAME_LIMITS.labelCharacters)) return refused(`label must name the option in 1 to ${RESEARCH_FRAME_LIMITS.labelCharacters} characters, as the page writes it.`);
    const url = value.url;
    if (url !== null && !isLink(url)) {
      return refused(`url must be the http or https link of the page that names the option, at most ${RESEARCH_LIMITS.urlCharacters} characters, or null.`);
    }
    return { ok: true, value: { change: "note_candidate", label: value.label, reason, ...isLink(url) ? { url } : {} } };
  }
  if (value.change === "set_aside") {
    if (!storableText(value.key, RESEARCH_FRAME_LIMITS.labelCharacters)) return refused("key must name the noted candidate, as the server listed it.");
    return { ok: true, value: { change: "set_aside", key: value.key, reason } };
  }
  if (value.change === "add_row") {
    const row = decodeRow({ key: value.key, label: value.label }, "");
    return row.ok ? { ok: true, value: { change: "add_row", reason, row: row.value } } : row;
  }
  if (value.change === "add_criterion") {
    if (!storableText(value.label, RESEARCH_FRAME_LIMITS.labelCharacters)) return refused(`label must be 1 to ${RESEARCH_FRAME_LIMITS.labelCharacters} characters.`);
    const criterion = decodeCriterion({ criterion: value.label, key: value.key, why: value.why }, "");
    return criterion.ok ? { ok: true, value: { change: "add_criterion", criterion: criterion.value, reason } } : criterion;
  }
  if (!storableText(value.label, RESEARCH_FRAME_LIMITS.labelCharacters)) return refused(`label must be 1 to ${RESEARCH_FRAME_LIMITS.labelCharacters} characters.`);
  const branch = decodeBranch({ cases: value.cases, key: value.key, unknown: value.label }, "");
  return branch.ok ? { ok: true, value: { branch: branch.value, change: "add_branch", reason } } : branch;
}

function decodeDataset(value: unknown): DecodedResearch<ResearchDataset> {
  const limits = RESEARCH_EVIDENCE_LIMITS;
  if (!isRecord(value)) return refused("dataset must be one object: method, sample_size, left_out, counts and examples.");
  if (!storableText(value.method, limits.methodCharacters)) return refused(`dataset.method must say in 1 to ${limits.methodCharacters} characters how it was collected.`);
  const sampleSize = value.sample_size;
  if (typeof sampleSize !== "number" || !Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > limits.sampleSize) {
    return refused(`dataset.sample_size must be the number of items the counts are out of, those kept after filtering, 1 to ${limits.sampleSize}.`);
  }
  if (!storableText(value.left_out, RESEARCH_LIMITS.reasonCharacters)) return refused(`dataset.left_out must say in 1 to ${RESEARCH_LIMITS.reasonCharacters} characters what was left out.`);
  if (!Array.isArray(value.examples) || value.examples.length < 1 || value.examples.length > limits.datasetExamples) {
    return refused(`dataset.examples must list 1 to ${limits.datasetExamples} verbatim examples.`);
  }
  const examples: ResearchDatasetExample[] = [];
  for (const [index, entry] of value.examples.entries()) {
    if (!isRecord(entry) || !storableText(entry.quote, RESEARCH_LIMITS.quoteCharacters) || !isLink(entry.url)) {
      return refused(`dataset.examples[${index}] needs quote, copied from the page, and url, its http or https link.`);
    }
    examples.push({ quote: entry.quote, url: entry.url });
  }
  if (!Array.isArray(value.counts) || value.counts.length > limits.datasetCounts) return refused(`dataset.counts must list at most ${limits.datasetCounts} counts.`);
  const counts: ResearchDatasetCount[] = [];
  for (const [index, entry] of value.counts.entries()) {
    const count = isRecord(entry) ? entry.count : undefined;
    if (!isRecord(entry) || !storableText(entry.label, RESEARCH_FRAME_LIMITS.labelCharacters) || typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > sampleSize) {
      return refused(`dataset.counts[${index}] needs label and count, a whole number up to the sample size.`);
    }
    counts.push({ count, label: entry.label });
  }
  return { ok: true, value: { counts, examples, leftOut: value.left_out, method: value.method, sampleSize } };
}

const isNumberWithin = (value: unknown, least: number, most: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= least && value <= most;

/** A rating in its tool's form, which is how `ResearchEvidence.rating` keeps it: `decodeResearchRecord` reads both. */
export function researchRatingDocument(rating: ResearchRating) {
  return { count: rating.count, counted: rating.counted, scale_max: rating.scaleMax, score: rating.score, variants_merged: rating.variantsMerged };
}

/** A finding's rating in its tool's form, or as a row keeps it; null where the finding is no rating. */
function decodeRating(value: unknown): DecodedResearch<ResearchRating | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  const limits = RESEARCH_EVIDENCE_LIMITS;
  if (!isRecord(value)) return refused("rating must be one object, score, scale_max, count, counted and variants_merged, or null for a finding that is no rating.");
  const { count, counted, scale_max: scaleMax, score, variants_merged: variantsMerged } = value;
  if (!isNumberWithin(scaleMax, Number.MIN_VALUE, limits.ratingScale)) return refused(`rating.scale_max must be the top of the scale, such as 5 or 10, at most ${limits.ratingScale}.`);
  if (!isNumberWithin(score, 0, scaleMax)) return refused("rating.score must be the score as the page shows it, from 0 to rating.scale_max.");
  if (!isNumberWithin(count, 1, limits.ratingCount) || !Number.isInteger(count)) {
    return refused(`rating.count must be the whole number of ratings the score is out of, 1 to ${limits.ratingCount}: an option with none is not_found for its cell.`);
  }
  if (!isOneOf(RESEARCH_RATING_COUNTS, counted)) return refused(`rating.counted must be one of ${RESEARCH_RATING_COUNTS.join(", ")}.`);
  if (typeof variantsMerged !== "boolean") return refused("rating.variants_merged must say whether the card merges the ratings of the option's variants.");
  return { ok: true, value: { count, counted, scaleMax, score, variantsMerged } };
}

/** `rating` is not among them: left out reads as none, so a call that leaves out what it has no use for, and a row stored before the field, keep their finding. */
const RECORD_FIELDS = ["claim", "criterion_key", "dataset", "kind", "quote", "reason", "row_key", "source_class", "standing", "supersedes", "target", "url"] as const;

const SOURCE_CLASS_RULE = `must be one of ${RESEARCH_SOURCE_CLASSES.join(", ")}`;

/** A record as `record_evidence` takes it: every field given, null where its kind has no use for it; the message names the field to correct. */
export function decodeResearchRecord(value: unknown): DecodedResearch<ResearchRecordInput> {
  if (!isRecord(value)) return refused("The arguments must be one object.");
  const missing = missingField(value, RECORD_FIELDS);
  if (missing) return refused(missing);
  const limits = RESEARCH_LIMITS;
  const { claim, criterion_key: criterionKey, kind, reason, row_key: rowKey, source_class: sourceClass, standing, supersedes, target, url } = value;
  if (!isOneOf(RESEARCH_RECORD_KINDS, kind)) return refused(`kind must be one of ${RESEARCH_RECORD_KINDS.join(", ")}.`);
  if (rowKey !== null && !isResearchKey(rowKey)) return refused(`row_key must be null or a matrix key: ${KEY_RULE}.`);
  if (criterionKey !== null && !isResearchKey(criterionKey)) return refused(`criterion_key must be null or a matrix key: ${KEY_RULE}.`);
  if (supersedes !== null && !isRecordId(supersedes)) return refused("supersedes must be null or the id of the record this one corrects.");
  if (sourceClass !== null && !isResearchSourceClass(sourceClass)) return refused(`source_class ${SOURCE_CLASS_RULE}, or null where it does not apply.`);
  const cell = { criterionKey, rowKey, supersedes };
  if (kind === "not_found") {
    if (rowKey === null || criterionKey === null) return refused("row_key and criterion_key must name the cell nothing was found for.");
    if (!storableText(reason, limits.reasonCharacters)) return refused(`reason must say in 1 to ${limits.reasonCharacters} characters where you looked.`);
    return { ok: true, value: { ...cell, criterionKey, kind, reason, rowKey, sourceClass } };
  }
  if (kind === "unreachable") {
    if (!storableText(target, limits.targetCharacters)) return refused(`target must name the site in 1 to ${limits.targetCharacters} characters.`);
    if (!storableText(reason, limits.reasonCharacters)) return refused(`reason must say in 1 to ${limits.reasonCharacters} characters why it could not be reached.`);
    return { ok: true, value: { ...cell, kind, reason, sourceClass, target } };
  }
  if (!storableText(claim, limits.claimCharacters)) return refused(`claim must be 1 to ${limits.claimCharacters} characters.`);
  if (!isLink(url)) return refused("url must be the http or https link of the source.");
  if (sourceClass === null) return refused(`source_class ${SOURCE_CLASS_RULE}.`);
  if (!(RESEARCH_STANDINGS as readonly unknown[]).includes(standing)) return refused(`standing must be one of ${RESEARCH_STANDINGS.join(", ")}.`);
  const source = { claim, sourceClass, standing: standing as ResearchStanding, url };
  if (kind === "dataset") {
    if (rowKey === null) return refused("row_key must name the exact model or option the dataset is about.");
    const dataset = decodeDataset(value.dataset);
    return dataset.ok ? { ok: true, value: { ...cell, ...source, dataset: dataset.value, kind, rowKey } } : dataset;
  }
  if (!storableText(value.quote, limits.quoteCharacters)) return refused(`quote must be 1 to ${limits.quoteCharacters} characters copied from the source.`);
  const rating = decodeRating(value.rating);
  if (!rating.ok) return rating;
  if (rating.value && rowKey === null) return refused("row_key must name the option this rating is of.");
  return { ok: true, value: { ...cell, ...source, kind, quote: value.quote, ...rating.value ? { rating: rating.value } : {} } };
}

/**
 * What ties a draft to the records and the matrix, from `submit_research_draft`'s arguments. Its tool asks for every field, null or empty where it does not apply, and is
 * not strict, so a model may leave one out: that is the same statement, and only a value of the wrong shape is refused.
 */
export function decodeResearchDraftReferences(value: unknown): DecodedResearch<ResearchDraftReferences> {
  if (!isRecord(value)) return refused("The arguments must be one object.");
  const limits = RESEARCH_FRAME_LIMITS;
  const rawNoSeparation: unknown = value.does_not_separate ?? null;
  const pickRowKey: unknown = value.pick_row_key ?? null;
  const recordIds: unknown = value.record_ids ?? [];
  const rawPicks: unknown = value.branch_picks ?? [];
  if (!Array.isArray(recordIds) || recordIds.length > RESEARCH_LIMITS.findings || !recordIds.every(isCitedRecord)) {
    return refused(`record_ids must list at most ${RESEARCH_LIMITS.findings} ids, each whole as the server gave it.`);
  }
  if (pickRowKey !== null && !isResearchKey(pickRowKey)) return refused("pick_row_key must be null or the key of the row picked.");
  const maxPicks = limits.branches * limits.casesPerBranch;
  if (!Array.isArray(rawPicks) || rawPicks.length > maxPicks) return refused(`branch_picks must list at most ${maxPicks} picks.`);
  const branchPicks: ResearchBranchPick[] = [];
  for (const [index, entry] of rawPicks.entries()) {
    if (!isRecord(entry) || !isResearchKey(entry.branch_key) || !isResearchKey(entry.case_key) || !isResearchKey(entry.row_key)) {
      return refused(`branch_picks[${index}] needs branch_key, case_key and row_key.`);
    }
    branchPicks.push({ branchKey: entry.branch_key, caseKey: entry.case_key, rowKey: entry.row_key });
  }
  let doesNotSeparate: ResearchNoSeparation | null = null;
  if (rawNoSeparation !== null) {
    const entry: Readonly<Record<string, unknown>> = isRecord(rawNoSeparation) ? rawNoSeparation : {};
    const { row_keys: rowKeys, statement, would_decide: wouldDecide } = entry;
    if (!Array.isArray(rowKeys) || rowKeys.length < 2 || rowKeys.length > limits.rows || !rowKeys.every(isResearchKey)) {
      return refused(`does_not_separate.row_keys must name 2 to ${limits.rows} rows the data does not tell apart.`);
    }
    if (!storableText(statement, RESEARCH_LIMITS.reasonCharacters)) return refused(`does_not_separate.statement must be 1 to ${RESEARCH_LIMITS.reasonCharacters} characters.`);
    if (!storableText(wouldDecide, RESEARCH_LIMITS.reasonCharacters)) return refused(`does_not_separate.would_decide must say in 1 to ${RESEARCH_LIMITS.reasonCharacters} characters what would decide.`);
    doesNotSeparate = { rowKeys, statement, wouldDecide };
  }
  return { ok: true, value: { branchPicks, doesNotSeparate, pickRowKey, recordIds } };
}

/** A summary's answers to the user's priorities: left out or null is none, as on a summary stored before them. */
function decodePriorityAnswers(value: unknown): DecodedResearch<readonly ResearchPriorityAnswer[]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  const limits = RESEARCH_LIMITS;
  const most = RESEARCH_FRAME_LIMITS.priorityCriteria;
  if (!Array.isArray(value) || value.length > most) return refused(`summary.priorities must list at most ${most} answers, one for each priority the plan marked.`);
  const answers: ResearchPriorityAnswer[] = [];
  for (const [index, entry] of value.entries()) {
    const at = `summary.priorities[${index}]`;
    if (!isRecord(entry) || !isResearchKey(entry.criterion_key)) return refused(`${at}.criterion_key must be the key of a criterion the plan marked as a priority.`);
    if (answers.some(({ criterionKey }) => criterionKey === entry.criterion_key)) return refused(`${at}.criterion_key repeats an earlier answer's: one answer for each priority.`);
    if (!storableText(entry.text, limits.priorityAnswerCharacters)) return refused(`${at}.text must be one sentence of 1 to ${limits.priorityAnswerCharacters} characters.`);
    const recordIds: unknown = entry.record_ids ?? [];
    if (!Array.isArray(recordIds) || recordIds.length > limits.priorityAnswerRecords || !recordIds.every(isCitedRecord)) {
      return refused(`${at}.record_ids must list at most ${limits.priorityAnswerRecords} ids, each whole as the server gave it.`);
    }
    answers.push({ criterionKey: entry.criterion_key, recordIds: [...new Set(recordIds)], text: entry.text });
  }
  return { ok: true, value: answers };
}

/**
 * A draft's summary, read apart from its references, so a mistyped row key costs neither the pick nor the summary's words. A text alone is a summary naming no
 * row, and the report check says what is missing; so does a missing one, which never refuses the draft (Answer first). So do answers to the priorities that
 * cannot be read: the summary keeps its words and rows without them.
 */
function decodeResearchSummary(value: unknown): Readonly<{ invalid?: string; summary: ResearchDraftSummary | null }> {
  if (value === undefined || value === null) return { summary: null };
  const entry: Readonly<Record<string, unknown>> = typeof value === "string" ? { row_keys: [], text: value } : isRecord(value) ? value : {};
  const { priorities: rawPriorities, row_keys: rowKeys = [], text } = entry;
  if (!storableText(text, RESEARCH_LIMITS.summaryCharacters)) {
    return { invalid: `summary.text must be 1 to ${RESEARCH_LIMITS.summaryCharacters} characters: two to four short paragraphs.`, summary: null };
  }
  const problems: string[] = [];
  const rowsRead = Array.isArray(rowKeys) && rowKeys.length <= RESEARCH_FRAME_LIMITS.rows && rowKeys.every(isResearchKey);
  if (!rowsRead) problems.push(`summary.row_keys must list at most ${RESEARCH_FRAME_LIMITS.rows} keys of the matrix's rows.`);
  const priorities = decodePriorityAnswers(rawPriorities);
  if (!priorities.ok) problems.push(priorities.message);
  const answered = priorities.ok && priorities.value.length > 0 ? { priorities: priorities.value } : {};
  const summary = { ...answered, rowKeys: rowsRead ? [...new Set(rowKeys as readonly string[])] : [], text };
  return problems.length > 0 ? { invalid: problems.join(" "), summary } : { summary };
}

/** The findings typed into a draft stored before drafts referred to records. */
function decodeTypedFindings(value: unknown): DecodedResearch<readonly ResearchFinding[]> {
  const limits = RESEARCH_LIMITS;
  if (!Array.isArray(value) || value.length > limits.findings) return refused(`findings must list at most ${limits.findings} findings.`);
  const findings: ResearchFinding[] = [];
  for (const [index, entry] of value.entries()) {
    const at = `findings[${index}]`;
    if (!isRecord(entry)) return refused(`${at} must be one object.`);
    if (!boundedText(entry.claim, limits.claimCharacters)) return refused(`${at}.claim must be 1 to ${limits.claimCharacters} characters.`);
    if (!boundedText(entry.url, limits.urlCharacters)) return refused(`${at}.url must be the link of the source.`);
    if (!boundedText(entry.quote, limits.quoteCharacters)) return refused(`${at}.quote must be 1 to ${limits.quoteCharacters} characters copied from the source.`);
    if (!isResearchSourceClass(entry.source_class)) return refused(`${at}.source_class must be one of ${RESEARCH_SOURCE_CLASSES.join(", ")}.`);
    if (!(RESEARCH_STANDINGS as readonly unknown[]).includes(entry.standing)) return refused(`${at}.standing must be one of ${RESEARCH_STANDINGS.join(", ")}.`);
    findings.push({ claim: entry.claim, quote: entry.quote, sourceClass: entry.source_class, standing: entry.standing as ResearchStanding, url: entry.url });
  }
  return { ok: true, value: findings };
}

/**
 * A draft as `submit_research_draft` takes it; the message names the field to correct. It refers to records, and the server fills its findings from
 * them. A stored transcript keeps the form from before that, findings typed in the call, which `researchOfTurn` reads back, so that form decodes as it always did.
 * It takes a finding to be that form: an empty list says nothing, a stored draft with one loses nothing by reading as a live one, and a live one sent beside a pick
 * would lose the pick and the check with it. A model that sends findings now goes back at the report check, not here, where nothing could say why. The same goes
 * for references that cannot be read: refused here, a key mistyped on the last call would cost the whole report, and past the send-back cap too (Answer first).
 * Edits need the latest draft the checks sent back, supplied by the run or by transcript replay; only its report and an omitted summary carry forward.
 */
export function decodeResearchDraft(value: unknown, previous?: ResearchDraft | null): DecodedResearch<ResearchDraft> {
  if (!isRecord(value)) return refused("The arguments must be one object.");
  const limits = RESEARCH_LIMITS;
  if (value.edits !== undefined) {
    if (value.report !== undefined) return refused("Pass either report or edits, not both.");
    if (!previous) return refused("edits needs a previous draft sent back by the checks; pass the whole report first.");
    const edited = editResearchReport(previous.report, value.edits);
    if (!edited.ok) return edited;
    const { edits: _edits, ...fields } = value;
    const decoded = decodeResearchDraft({ ...fields, report: edited.value });
    if (!decoded.ok || value.summary !== undefined) return decoded;
    return { ok: true, value: { ...decoded.value, summary: previous.summary,
      ...previous.invalidSummary === undefined ? {} : { invalidSummary: previous.invalidSummary } } };
  }
  if (!boundedText(value.report, limits.reportCharacters)) return refused(`report must be 1 to ${limits.reportCharacters} characters.`);
  const stored = Array.isArray(value.findings) && value.findings.length > 0 && value.record_ids === undefined;
  const findings = stored ? decodeTypedFindings(value.findings) : null;
  if (findings && !findings.ok) return findings;
  const references = stored ? null : decodeResearchDraftReferences(value);
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
  const referred = !references ? {} : references.ok ? references.value : { invalidReferences: references.message };
  const summary = stored ? null : decodeResearchSummary(value.summary);
  const summarized = !summary ? {} : { summary: summary.summary, ...summary.invalid === undefined ? {} : { invalidSummary: summary.invalid } };
  return { ok: true, value: { ...referred, ...summarized, findings: findings?.value ?? [], origin: "reserved_call", report: value.report, unreachable } };
}

/** All matches belong to the previous report, never text another edit inserted. Nothing is applied until every edit is valid. */
function editResearchReport(report: string, value: unknown): DecodedResearch<string> {
  const limits = RESEARCH_LIMITS;
  if (!Array.isArray(value) || value.length > limits.draftEdits) return refused(`edits must list at most ${limits.draftEdits} old/new pairs; [] keeps the report.`);
  const replacements: { end: number; index: number; start: number; text: string }[] = [];
  let characters = 0;
  for (const [index, entry] of value.entries()) {
    const at = `edits[${index}]`;
    if (!isRecord(entry) || typeof entry.old !== "string" || entry.old.length === 0 || entry.old.length > limits.draftEditCharacters || entry.old.includes("\u0000")) {
      return refused(`${at}.old must be 1 to ${limits.draftEditCharacters} characters of exact report text, without NUL.`);
    }
    if (typeof entry.new !== "string" || entry.new.length > limits.draftEditCharacters || entry.new.includes("\u0000")) {
      return refused(`${at}.new must be 0 to ${limits.draftEditCharacters} characters, without NUL; empty deletes the old text.`);
    }
    characters += entry.old.length + entry.new.length;
    if (characters > limits.draftEditsCharacters) return refused(`${at} exceeds the edits total of ${limits.draftEditsCharacters} characters (old and new combined).`);
    const start = report.indexOf(entry.old);
    if (start < 0) return refused(`${at}.old was not found in the previous draft's report. No edits were applied.`);
    if (report.indexOf(entry.old, start + 1) >= 0) return refused(`${at}.old was found more than once in the previous draft's report. No edits were applied.`);
    const end = start + entry.old.length;
    const overlap = replacements.find((other) => start < other.end && end > other.start);
    if (overlap) return refused(`${at} overlaps edits[${overlap.index}] in the previous draft's report. No edits were applied.`);
    replacements.push({ end, index, start, text: entry.new });
  }
  const length = report.length + replacements.reduce((change, edit) => change + edit.text.length - (edit.end - edit.start), 0);
  if (length > limits.reportCharacters) return refused(`The edited report exceeds ${limits.reportCharacters} characters. No edits were applied.`);
  let edited = report;
  for (const edit of replacements.sort((one, other) => other.start - one.start)) edited = edited.slice(0, edit.start) + edit.text + edited.slice(edit.end);
  if (!boundedText(edited, limits.reportCharacters)) return refused("The edited report is empty. No edits were applied.");
  return { ok: true, value: edited };
}
