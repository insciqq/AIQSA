import type {
  ResearchDataset, ResearchDraft, ResearchDraftSummary, ResearchEvidenceRecord, ResearchFrame, ResearchRating, ResearchSourceClass, ResearchStanding
} from "../../contracts/research";
import { researchMatrixCoverage, type ResearchMatrix } from "./matrix";

/**
 * A purchase research as a real run left it: specifications, prices, sellers and owners' reviews recorded for two mattresses. The ids are UUIDs, as the contract wants.
 */
export const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

const base = (number: number, rowKey: string | null, criterionKey: string | null) => ({ author: { name: "lab", threadId: "thread-1" }, createdAt: "2026-11-01T10:00:00.000Z", criterionKey, id: id(number),
  pageId: null, publishedOn: null, registrableDomain: null, rowKey, runId: "run-1", sequence: number, supersedes: null, textGroupKey: null });

export function finding(number: number, rowKey: string | null, criterionKey: string | null, overrides: Partial<Readonly<{ claim: string; quote: string;
  quoteCheck: ResearchEvidenceRecord["quoteCheck"]; rating: ResearchRating; registrableDomain: string; publishedOn: string; sourceClass: ResearchSourceClass; standing: ResearchStanding;
  supersedes: string; url: string }>> = {}): ResearchEvidenceRecord {
  return { ...base(number, rowKey, criterionKey), claim: `Claim ${number}.`, kind: "finding", quote: `Quote ${number}.`, quoteCheck: { reason: null, status: "found" }, sourceClass: "primary_official", standing: "confirmed",
    url: `https://source.example/${number}`, ...overrides };
}

/**
 * A public rating of an option as a researcher records it, under the ratings criterion of `RATED`, its quote writing the score and the count as the page does. Its platform is
 * the site of its link. Synthetic, as every fixture here.
 */
export const rating = (number: number, rowKey: string, score: number, count: number, site: string, overrides: Partial<ResearchRating> = {}): ResearchEvidenceRecord =>
  finding(number, rowKey, "ratings", { claim: `Rated ${score} of 5 by ${count} people on ${site}.`, quote: `${score} ★ ${count} оценок`,
    rating: { count, counted: "ratings", scaleMax: 5, score, variantsMerged: false, ...overrides }, sourceClass: "owner_reviews", url: `https://${site}/${rowKey}` });

export const DATASET: ResearchDataset = { counts: [{ count: 3, label: "sagging" }], examples: [{ quote: "Просел за год.", url: "https://shop.example/x1/reviews" }], leftOut: "Dropped 40 reviews of other sizes.",
  method: "Read the card's reviews to the end and kept those naming 160x200.", sampleSize: 11 };

export function dataset(number: number, rowKey: string, criterionKey: string | null, overrides: Partial<ResearchDataset> = {}): ResearchEvidenceRecord {
  return { ...base(number, rowKey, criterionKey), claim: `Dataset ${number}.`, dataset: { ...DATASET, ...overrides }, kind: "dataset", quoteCheck: { reason: null, status: "found" }, rowKey, sourceClass: "owner_reviews",
    standing: "confirmed", url: `https://shop.example/${number}` };
}

export const notFound = (number: number, rowKey: string, criterionKey: string): ResearchEvidenceRecord =>
  ({ ...base(number, rowKey, criterionKey), criterionKey, kind: "not_found", quoteCheck: null, reason: "Looked at the maker and three shops.", rowKey, sourceClass: null });

export const unreachable = (number: number, target: string, reason: string): ResearchEvidenceRecord =>
  ({ ...base(number, null, null), kind: "unreachable", quoteCheck: null, reason, sourceClass: "action_channel", target });

export const FRAME: ResearchFrame = {
  branches: [],
  changes: [],
  criteria: [{ criterion: "Цена за 160×200", key: "price", why: "Бюджет решает выбор." }, { criterion: "Отзывы владельцев", key: "reviews", why: "Показывают, что бывает через год." },
    { criterion: "Жёсткость", key: "firmness", why: "От неё зависит спина." }],
  rows: [{ key: "x1", label: "Lonax Memory" }, { key: "x2", label: "Optima Classic" }]
};

/** The purchase of `FRAME` with the column of ratings a choice among options holds, as the server adds it. */
export const RATED: ResearchFrame = { ...FRAME, criteria: [...FRAME.criteria, { criterion: "Рейтинг и отзывы", key: "ratings", ratings: true, why: "Оценка многих говорит больше нескольких отзывов." }] };

/** Row x1 holds a specification and, like the real pick, its price and its reviews. */
export const RECORDS: readonly ResearchEvidenceRecord[] = [
  finding(1, "x1", "firmness", { url: "https://maker.example/x1" }),
  finding(2, "x1", "price", { sourceClass: "action_channel", url: "https://shop.example/x1" }),
  dataset(3, "x1", "reviews"),
  finding(4, "x2", "firmness", { url: "https://maker.example/x2" }),
  finding(5, "x2", "price", { sourceClass: "action_channel", url: "https://shop.example/x2" })
];

export const matrixOf = (frame: ResearchFrame, records: readonly ResearchEvidenceRecord[]): ResearchMatrix => ({ coverage: researchMatrixCoverage(frame, records), frame });

export const MATRIX = matrixOf(FRAME, RECORDS);

export const TABLE = ["| Вариант | Цена за 160×200 | Отзывы владельцев | Жёсткость |", "| --- | --- | --- | --- |", "| Lonax Memory | 30 000 ₽ | 3 из 11 | средняя |", "| Optima Classic | 25 000 ₽ | нет данных | жёсткая |"].join("\n");

/** What the reader reads first: the pick, named as the matrix names it, with its price and its shop. */
export const SUMMARY: ResearchDraftSummary = { rowKeys: ["x1"], text: `Для ваших условий берите ${FRAME.rows[0]!.label}: 30 000 ₽ в магазине.` };

/** A draft that holds up: its summary, the pick's evidence named, a table on every criterion and nothing linked. */
export const DRAFT: ResearchDraft = { branchPicks: [], doesNotSeparate: null, findings: [], origin: "reserved_call", pickRowKey: "x1", recordIds: [id(1), id(2), id(3)],
  report: `# Отчёт\n\nБерите Lonax Memory.\n\n${TABLE}\n`, summary: SUMMARY, unreachable: [] };
