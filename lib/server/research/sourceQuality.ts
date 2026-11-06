import { createHash } from "node:crypto";
import { getDomain } from "tldts";
import {
  RESEARCH_PAGE_LIMITS, RESEARCH_RATING_WEIGHING, type ResearchEvidenceRecord, type ResearchRating, type ResearchRecordInput, type ResearchSourceClass, type ResearchStanding
} from "../../contracts/research";
import { normalizeFetchUrl } from "../webFetch/urls";

export type ResearchSourceQuality = Readonly<{ publishedOn: string | null; registrableDomain: string | null; textGroupKey: string | null }>;

/** Private suffixes distinguish separately operated sites on a shared hosting service. */
export function researchRegistrableDomain(link: string): string | null {
  try {
    const url = new URL(link);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    return getDomain(host, { allowPrivateDomains: true }) ?? host;
  } catch {
    return null;
  }
}

/**
 * The site a closing names (`researchUnreachableSites`): its host, without `www.`, a port or a final dot (operator decision 2026-11-05),
 * so a shop on a portal's subdomain closes only itself, while sources are still told apart by registrable domain. A target can be a bare
 * host or a URL; null for anything that is no http(s) host.
 */
export function researchSiteHost(target: string): string | null {
  const trimmed = target.trim();
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase().replace(/\.$/u, "").replace(/^www\./u, "");
    return host && host.length <= 253 ? host : null;
  } catch {
    return null;
  }
}

const linkOf = (record: ResearchRecordInput): string | null =>
  record.kind === "finding" || record.kind === "dataset" ? record.url : record.kind === "unreachable" ? record.target : null;

const domainOf = (record: ResearchEvidenceRecord): string | null => record.registrableDomain ?? researchRegistrableDomain(linkOf(record) ?? "");

/** Both a price and a purchase control are needed; a review mentioning a price alone is not a shop page. */
export function researchShopText(text: string): boolean {
  const normalized = text.slice(0, RESEARCH_PAGE_LIMITS.bytesPerPage).normalize("NFKC").toLowerCase();
  const price = /(?:(?:[$€£₽¥]|\b(?:usd|eur|gbp|rub))\s{0,8}\d|\d[\d\s.,]{0,24}(?:[$€£₽¥]|usd\b|eur\b|gbp\b|rub\b|руб(?:\.|ля|лей)?(?:\s|$)))/u;
  const control = /(?:^|\n)\s*(?:[-*]\s*)?(?:(?:button|link)\s+["'])?(?:\[)?(?:add to (?:cart|basket)|buy now|order now|place order|в корзину|добавить в корзину|купить|заказать|оформить заказ|añadir (?:al carrito|a la cesta|al carro)|agregar al carrito|comprar?(?: ya| ahora)?|realizar pedido|tramitar pedido|finalizar compra|afegeix (?:a la cistella|al carro|al carret)|afegir (?:a la cistella|al carro|al carret)|afig (?:a la cistella|al carro|al carret)|comprar? ara|fer la comanda|tramitar la comanda)(?:\])?(?:["'](?:\s+\[ref=[^\]\n]+\])?)?\s*$/mu;
  return price.test(normalized) && control.test(normalized);
}

// Eight of 64 bits tolerate heading edits; unrelated word trigrams normally differ in about half the bits.
const NEAR_TEXT_BITS = 8;
const FUZZY_MIN_WORDS = 40;
const KEY_PATTERN = /^([12])([01])([0-9a-f]{16})$/u;

/**
 * Hex keys hold a mode (1: SimHash, 2: exact short text), a shop bit and a 64-bit fingerprint. The shop bit preserves the page's
 * server-observed purchase controls without changing the submitted class or storing more text. Only matching shop bits group:
 * removing purchase controls changes whether a purported independent test can count, even when its remaining prose is a copy.
 */
export function researchTextFingerprint(text: string): string | null {
  const bounded = text.slice(0, RESEARCH_PAGE_LIMITS.bytesPerPage);
  const words = bounded.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return null;
  const shop = researchShopText(bounded) ? "1" : "0";
  if (words.length < FUZZY_MIN_WORDS) return `2${shop}${createHash("sha256").update(words.join(" ")).digest("hex").slice(0, 16)}`;
  const shingles = new Set<string>();
  for (let index = 0; index + 2 < words.length; index += 1) shingles.add(words.slice(index, index + 3).join(" "));
  const votes = new Int32Array(64);
  for (const shingle of shingles) {
    const hash = createHash("sha256").update(shingle).digest();
    for (let half = 0; half < 2; half += 1) {
      const bits = hash.readUInt32BE(half * 4);
      for (let bit = 0; bit < 32; bit += 1) votes[half * 32 + bit] += (bits >>> bit) & 1 ? 1 : -1;
    }
  }
  let fingerprint = 0n;
  for (let bit = 0; bit < votes.length; bit += 1) if (votes[bit] > 0) fingerprint |= 1n << BigInt(bit);
  return `1${shop}${fingerprint.toString(16).padStart(16, "0")}`;
}

/** The first compatible representative wins; callers read only keys under the append lock, in creation order. */
export function researchTextGroupKey(fingerprint: string | null, earlier: readonly (string | null)[]): string | null {
  if (fingerprint === null) return null;
  const current = KEY_PATTERN.exec(fingerprint);
  if (!current) return fingerprint;
  for (const key of earlier.slice(0, RESEARCH_PAGE_LIMITS.pagesPerRun)) {
    if (key === fingerprint) return key;
    if (key === null || current[1] !== "1" || key.slice(0, 2) !== fingerprint.slice(0, 2) || !KEY_PATTERN.test(key)) continue;
    let difference = BigInt(`0x${current[3]}`) ^ BigInt(`0x${key.slice(2)}`);
    let distance = 0;
    while (difference !== 0n && distance <= NEAR_TEXT_BITS) {
      difference &= difference - 1n;
      distance += 1;
    }
    if (distance <= NEAR_TEXT_BITS) return key;
  }
  return fingerprint;
}

const MONTHS: Readonly<Record<string, number>> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6, июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  // Catalan and Valencian; abril and octubre are the same as in Spanish.
  gener: 1, giner: 1, febrer: 2, març: 3, maig: 5, juny: 6, juliol: 7, agost: 8, setembre: 9, novembre: 11, desembre: 12
};

const daysInMonth = (year: number, month: number) => month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
  : [4, 6, 9, 11].includes(month) ? 30 : 31;

function dateParts(text: string): Readonly<{ year: number; month: number | null; day: number | null }> | null {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] === undefined ? null : Number(match[2]);
  const day = match[3] === undefined ? null : Number(match[3]);
  if (year < 1 || (month !== null && (month < 1 || month > 12)) || (day !== null && (day < 1 || day > daysInMonth(year, month ?? 1)))) return null;
  return { year, month, day };
}

function publicationDate(value: string): string | null {
  const raw = value.trim().toLowerCase();
  if (dateParts(raw)) return raw;
  // "5 марта 2024 г.", "5 de marzo de 2024" and the Valencian "5 d'abril del 2024".
  const dayFirst = /^(\d{1,2})\s+(?:de\s+|d['’])?([\p{L}]+)\s+(?:del?\s+)?(\d{4})(?:\s+г\.?)?$/u.exec(raw);
  const monthFirst = /^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/u.exec(raw);
  const monthOnly = /^([\p{L}]+)\s+(?:del?\s+)?(\d{4})$/u.exec(raw);
  const month = MONTHS[dayFirst?.[2] ?? monthFirst?.[1] ?? monthOnly?.[1] ?? ""];
  if (!month) return null;
  const year = dayFirst?.[3] ?? monthFirst?.[3] ?? monthOnly?.[2];
  if (year === undefined) return null;
  const day = dayFirst?.[1] ?? monthFirst?.[2];
  const date = `${year}-${String(month).padStart(2, "0")}${day === undefined ? "" : `-${day.padStart(2, "0")}`}`;
  return dateParts(date) ? date : null;
}

/** Only explicit, standalone publication labels near the page header qualify; body dates, updates and citations do not. */
export function researchPublishedOn(text: string): string | null {
  let date: string | null = null;
  const lines = text.slice(0, 2_000).split(/\r?\n/u).slice(0, 20);
  for (const line of lines) {
    if (/^\s*(?:#{1,6}\s*)?(?:references|sources|related articles|источники|литература|похожие статьи|referencias|fuentes|bibliografía|artículos relacionados|referències|fonts|bibliografia|articles relacionats)\s*:?\s*$/iu.test(line)) break;
    const label = /^\s*(?:published(?:\s+on)?|publication date|date published|дата публикации|опубликовано|опубликован[ао]?|publicado(?:\s+el)?|fecha de publicación|publicat(?:\s+el)?|data de publicació)\s*:?\s+(.+?)\s*$/iu.exec(line);
    if (!label) continue;
    const found = publicationDate(label[1]);
    if (found === null) return null;
    if (date !== null && !date.startsWith(found) && !found.startsWith(date)) return null;
    if (date === null || found.length > date.length) date = found;
  }
  return date;
}

/** Computed before the append lock, and only from the cited page: a quote found on another page gives that link no metadata. */
export function prepareResearchSourceQuality(record: ResearchRecordInput, page: Readonly<{ text: string; url: string }> | null): ResearchSourceQuality {
  const link = linkOf(record);
  const cited = link === null ? null : normalizeFetchUrl(link);
  const text = page !== null && cited !== null && normalizeFetchUrl(page.url) === cited ? page.text : null;
  return { publishedOn: text === null ? null : researchPublishedOn(text), registrableDomain: link === null ? null : researchRegistrableDomain(link),
    textGroupKey: text === null ? null : researchTextFingerprint(text) };
}

/** Completed UTC months, conservatively the minimum age for a partial date; a future or unknown publication gives no age. */
export function researchSourceAgeMonths(record: Pick<ResearchEvidenceRecord, "publishedOn">, asOf: Date): number | null {
  const parts = record.publishedOn === null ? null : dateParts(record.publishedOn);
  if (parts === null || !Number.isFinite(asOf.getTime())) return null;
  const { year, month, day } = parts;
  const today = asOf.toISOString().slice(0, 10);
  const earliest = `${String(year).padStart(4, "0")}-${String(month ?? 1).padStart(2, "0")}-${String(day ?? 1).padStart(2, "0")}`;
  if (earliest > today) return null;
  const latestMonth = month ?? 12;
  const latestDay = day ?? daysInMonth(year, latestMonth);
  const months = (asOf.getUTCFullYear() - year) * 12 + asOf.getUTCMonth() + 1 - latestMonth;
  return Math.max(0, months - (asOf.getUTCDate() < latestDay ? 1 : 0));
}

const shopKey = (key: string | null): boolean => key !== null && KEY_PATTERN.test(key) && key[1] === "1";
const ownSellerSignal = (record: ResearchEvidenceRecord): boolean => record.sourceClass === "action_channel" || shopKey(record.textGroupKey);

function sellerDomains(records: readonly ResearchEvidenceRecord[]): ReadonlySet<string> {
  const domains = new Set<string>();
  for (const record of records) {
    const domain = domainOf(record);
    if (domain !== null && ownSellerSignal(record)) domains.add(domain);
  }
  return domains;
}

const sellerSource = (record: ResearchEvidenceRecord, domains: ReadonlySet<string>) => ownSellerSignal(record) || domains.has(domainOf(record) ?? "");
const sellerTest = (record: ResearchEvidenceRecord, domains: ReadonlySet<string>) => record.sourceClass === "independent_tests" && sellerSource(record, domains);

/** Only a seller's purported independent test changes class; owners' reviews and makers' documents retain their authorship on a shop page. */
export function researchSourceClass(record: ResearchEvidenceRecord, liveRecords: readonly ResearchEvidenceRecord[]): ResearchSourceClass | null {
  return sellerTest(record, sellerDomains(liveRecords)) ? "action_channel" : record.sourceClass;
}

/** A seller's purported independent test is a party's claim; other classes keep their submitted standing, including marketplace owner reviews. */
export function researchSourceStanding(record: ResearchEvidenceRecord, liveRecords: readonly ResearchEvidenceRecord[]): ResearchStanding | null {
  if (record.kind !== "finding" && record.kind !== "dataset") return null;
  return sellerTest(record, sellerDomains(liveRecords)) ? "claimed" : record.standing;
}

type CountedSource = Readonly<{ domain: string | null; sourceClass: ResearchSourceClass; textGroupKey: string | null }>;

/** Domains join pages of one site; text keys join copies across sites, so a site with several texts still counts once. */
function groupedSources(records: readonly CountedSource[]) {
  const parents = new Map<string, string>();
  const root = (key: string): string => {
    let head = key;
    while (parents.has(head) && parents.get(head) !== head) head = parents.get(head) ?? head;
    let next = key;
    while (parents.has(next) && parents.get(next) !== head) {
      const parent = parents.get(next);
      parents.set(next, head);
      if (parent === undefined) break;
      next = parent;
    }
    return head;
  };
  const sources: Array<Readonly<{ key: string; sourceClass: ResearchSourceClass }>> = [];
  for (const record of records) {
    const domain = record.domain;
    const domainKey = domain === null ? null : `domain:${domain}`;
    const textKey = record.textGroupKey === null ? null : `text:${record.textGroupKey}`;
    const key = textKey ?? domainKey;
    if (key === null) continue;
    if (!parents.has(key)) parents.set(key, key);
    if (domainKey !== null) parents.set(root(domainKey), root(key));
    sources.push({ key, sourceClass: record.sourceClass });
  }
  return sources.map((source) => ({ key: root(source.key), sourceClass: source.sourceClass }));
}

/**
 * Live findings and datasets count under their effective classes. Only independent tests and owner reviews form the independent
 * groups; maker and action-channel records neither add to nor connect those groups. For a cell's subset, pass all live records as
 * researchRecords so a seller recorded in another cell cannot pass as an independent test. Unreachable and not-found records are
 * coverage outcomes, not sources.
 */
export function researchSourceCounts(records: readonly ResearchEvidenceRecord[], researchRecords: readonly ResearchEvidenceRecord[] = records):
  Readonly<{ independent: number; byClass: Readonly<Record<ResearchSourceClass, number>> }> {
  const sellers = sellerDomains(researchRecords);
  const sources = records.flatMap((record): CountedSource[] => record.kind === "finding" || record.kind === "dataset"
    ? [{ domain: domainOf(record), sourceClass: sellerTest(record, sellers) ? "action_channel" : record.sourceClass, textGroupKey: record.textGroupKey }] : []);
  const classes: Record<ResearchSourceClass, Set<string>> = { action_channel: new Set(), independent_tests: new Set(), owner_reviews: new Set(), primary_official: new Set() };
  for (const source of groupedSources(sources)) classes[source.sourceClass].add(source.key);
  const independent = sources.filter((source) => source.sourceClass === "independent_tests" || source.sourceClass === "owner_reviews");
  const groups = new Set(groupedSources(independent).map((source) => source.key));
  return { independent: groups.size, byClass: { action_channel: classes.action_channel.size, independent_tests: classes.independent_tests.size,
    owner_reviews: classes.owner_reviews.size, primary_official: classes.primary_official.size } };
}

export const countIndependentSources = (records: readonly ResearchEvidenceRecord[], researchRecords: readonly ResearchEvidenceRecord[] = records): number =>
  researchSourceCounts(records, researchRecords).independent;

/** Coverage counts include every effective class; only the separate independent total excludes primary and action-channel sources. */
export const countIndependentSourcesByClass = (records: readonly ResearchEvidenceRecord[], researchRecords: readonly ResearchEvidenceRecord[] = records): Readonly<Record<ResearchSourceClass, number>> =>
  researchSourceCounts(records, researchRecords).byClass;

/** A finding of a public rating as the store keeps it (`ResearchRating`). */
export type ResearchRatingRecord = Extract<ResearchEvidenceRecord, Readonly<{ kind: "finding" }>> & Readonly<{ rating: ResearchRating }>;

/**
 * A rating whose numbers stand: a finding with its rating whose quote checked out or could not be checked. One whose quote lacks its score or its count is marked as a
 * wrong quote is (`rating_not_in_quote`, `evidenceStore.ts`) and weighs nothing, like any quote that did not check out.
 */
export const researchTrustedRating = (record: ResearchEvidenceRecord): record is ResearchRatingRecord =>
  record.kind === "finding" && record.rating !== undefined && (record.quoteCheck?.status === "found" || record.quoteCheck?.status === "not_checked");

/**
 * A rating weighed by its sample (operator decision 2026-11-05, `RESEARCH_RATING_WEIGHING`): its score as a share of its scale, pulled towards the neutral share as though
 * the prior's ratings had been given too, so ratings on scales of 5, 10 or 100 compare and 4.8 from 5,000 ratings stands above 5.0 from 7. What its number counts and whether
 * its card merges variants weigh nothing: the report says those.
 */
export function researchWeighedRating(rating: Pick<ResearchRating, "count" | "scaleMax" | "score">): number {
  const { neutralShare, priorRatings } = RESEARCH_RATING_WEIGHING;
  return (rating.count * (rating.score / rating.scaleMax) + priorRatings * neutralShare) / (rating.count + priorRatings);
}

/**
 * Of an option's ratings, the one it is compared by: the one from the most ratings, as researchers are told to take it (operator decision 2026-11-05). So a seller's own page,
 * whose few reviews carried a real run's pick, is shown and never compared where a platform with more ratings rates the option, and counts where none does. A tie goes to the
 * higher weighed score, then to the later record. Null with none: no score is ever guessed.
 */
export function researchMostRated(ratings: readonly ResearchRatingRecord[]): ResearchRatingRecord | null {
  return ratings.reduce<ResearchRatingRecord | null>((best, record) => {
    if (best === null || record.rating.count > best.rating.count) return record;
    if (record.rating.count < best.rating.count) return best;
    return researchWeighedRating(record.rating) >= researchWeighedRating(best.rating) ? record : best;
  }, null);
}

/** The rating an option of the matrix is compared by (`researchMostRated`), of its trusted ratings no check rejected, whatever criterion they were recorded under. */
export function researchComparedRating(records: readonly ResearchEvidenceRecord[], rowKey: string, rejected: ReadonlySet<string> = new Set()): ResearchRatingRecord | null {
  return researchMostRated(records.filter((record): record is ResearchRatingRecord => researchTrustedRating(record) && record.rowKey === rowKey && !rejected.has(record.id)));
}
