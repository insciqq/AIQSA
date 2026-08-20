export const KNOWLEDGE_PLANNER_TARGET_MAXIMUM = 8;
export const KNOWLEDGE_PLANNER_TARGET_CANDIDATE_MAXIMUM = 32;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SOURCE_ALIAS = /^S[1-9]\d{0,2}$/u;
const DISALLOWED_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const VERSION_QUALIFIER = /(?:^|[\s,;([])(?:v(?:ersion)?|верси(?:я|и|ю))\s*[#№]?\s*(\d{1,9})(?=$|[\s,;.)\]])/iu;
const DATE = /\b(?:(\d{4})[-./](\d{1,2})[-./](\d{1,2})|(\d{1,2})[-./](\d{1,2})[-./](\d{4}))\b/gu;

export type KnowledgePlannerSourceIdentity = Readonly<{
  fileName: string;
  sourceAlias: string;
  sourceId: string;
  sourceName: string;
  versionNumber: number;
}>;

export type KnowledgePlannerTargetOutcome =
  | "resolved"
  | "resolved_many"
  | "ambiguous"
  | "not_found";

export type KnowledgePlannerTargetMatch = Readonly<{
  candidateSourceIds: readonly string[];
  matchKind: "alias" | "file_name" | "fuzzy" | "none" | "normalized_title" | "scope" | "source_name";
  outcome: "ambiguous" | "not_found" | "resolved";
  targetName: string;
}>;

export type KnowledgePlannerTargetResolution = Readonly<{
  outcome: KnowledgePlannerTargetOutcome;
  targetSourceIds: readonly string[];
  targets: readonly KnowledgePlannerTargetMatch[];
}>;

function boundedCanonicalText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || DISALLOWED_TEXT.test(value)) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function comparableText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/ё/gu, "е").trim();
}

function normalizedTitle(value: string): string {
  const basename = value.split(/[\\/]/u).at(-1) ?? value;
  return comparableText(basename)
    .replace(/\.[\p{L}\p{N}]{1,12}$/u, "")
    .replace(/["'`“”«»]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function canonicalDate(year: string, month: string, day: string): string | null {
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  if (numericYear < 1900 || numericYear > 2200 || numericMonth < 1 || numericMonth > 12 ||
    numericDay < 1 || numericDay > 31) return null;
  return `${String(numericYear).padStart(4, "0")}-${String(numericMonth).padStart(2, "0")}-${String(numericDay).padStart(2, "0")}`;
}

function datesIn(value: string): string[] {
  const dates: string[] = [];
  for (const match of value.matchAll(DATE)) {
    const date = match[1]
      ? canonicalDate(match[1], match[2]!, match[3]!)
      : canonicalDate(match[6]!, match[5]!, match[4]!);
    if (date) dates.push(date);
  }
  return unique(dates);
}

function withoutQualifiers(value: string): Readonly<{
  dates: readonly string[];
  name: string;
  versionNumber: number | null;
}> {
  const version = value.match(VERSION_QUALIFIER);
  const dates = datesIn(value);
  let name = value.replace(VERSION_QUALIFIER, " ");
  for (const date of value.matchAll(DATE)) {
    name = name.replace(date[0], " ");
  }
  return {
    dates,
    name: name.replace(/\s+/gu, " ").trim(),
    versionNumber: version ? Number(version[1]) : null
  };
}

function distance(left: string, right: string, maximum: number): number {
  const leftCharacters = [...left];
  const rightCharacters = [...right];
  if (leftCharacters.length === rightCharacters.length) {
    const differences = leftCharacters.flatMap((character, index) =>
      character === rightCharacters[index] ? [] : [index]);
    if (differences.length === 2 && differences[1] === differences[0]! + 1 &&
      leftCharacters[differences[0]!] === rightCharacters[differences[1]!] &&
      leftCharacters[differences[1]!] === rightCharacters[differences[0]!]) return 1;
  }
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const value = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + cost
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maximum) return maximum + 1;
    previous = current;
  }
  return previous[right.length]!;
}

function typoMaximum(value: string): number {
  if (value.length < 5) return 0;
  if (value.length < 10) return 1;
  return 2;
}

function validateSources(
  values: readonly KnowledgePlannerSourceIdentity[]
): readonly KnowledgePlannerSourceIdentity[] {
  if (values.length > 999) throw new Error("knowledge_planner_source_identity_invalid");
  const byId = new Map<string, KnowledgePlannerSourceIdentity>();
  const aliases = new Set<string>();
  for (const value of values) {
    const fileName = boundedCanonicalText(value.fileName, 1_024);
    const sourceName = boundedCanonicalText(value.sourceName, 512);
    if (!UUID.test(value.sourceId) || !SOURCE_ALIAS.test(value.sourceAlias) ||
      !fileName || !sourceName || !Number.isSafeInteger(value.versionNumber) ||
      value.versionNumber < 1 || aliases.has(value.sourceAlias) || byId.has(value.sourceId)) {
      throw new Error("knowledge_planner_source_identity_invalid");
    }
    aliases.add(value.sourceAlias);
    byId.set(value.sourceId, {
      fileName,
      sourceAlias: value.sourceAlias,
      sourceId: value.sourceId,
      sourceName,
      versionNumber: value.versionNumber
    });
  }
  return [...byId.values()];
}

function candidatesForTarget(
  targetName: string,
  sources: readonly KnowledgePlannerSourceIdentity[]
): Readonly<{
  candidateSourceIds: readonly string[];
  matchKind: KnowledgePlannerTargetMatch["matchKind"];
}> {
  const qualifiers = withoutQualifiers(targetName);
  const rawComparableTarget = comparableText(targetName)
    .replace(/^["'`“«]+|["'`”»]+$/gu, "")
    .trim();
  const comparableTarget = comparableText(qualifiers.name || targetName)
    .replace(/^["'`“«]+|["'`”»]+$/gu, "")
    .trim();
  const targetTitle = normalizedTitle(qualifiers.name || targetName);
  const eligible = sources.filter((source) => {
    if (qualifiers.versionNumber !== null && source.versionNumber !== qualifiers.versionNumber) {
      return false;
    }
    if (qualifiers.dates.length === 0) return true;
    const sourceDates = new Set(datesIn(`${source.fileName} ${source.sourceName}`));
    return qualifiers.dates.every((date) => sourceDates.has(date));
  });
  const alias = eligible.filter((source) =>
    comparableText(source.sourceAlias) === rawComparableTarget ||
    comparableText(source.sourceAlias) === comparableTarget);
  if (alias.length > 0) {
    return { candidateSourceIds: alias.map((source) => source.sourceId), matchKind: "alias" };
  }
  const fileName = eligible.filter((source) =>
    comparableText(source.fileName) === rawComparableTarget ||
    comparableText(source.fileName) === comparableTarget);
  if (fileName.length > 0) {
    return { candidateSourceIds: fileName.map((source) => source.sourceId), matchKind: "file_name" };
  }
  const sourceName = eligible.filter((source) =>
    comparableText(source.sourceName) === rawComparableTarget ||
    comparableText(source.sourceName) === comparableTarget);
  if (sourceName.length > 0) {
    return { candidateSourceIds: sourceName.map((source) => source.sourceId), matchKind: "source_name" };
  }

  const candidateTitle = (value: string): string => normalizedTitle(
    qualifiers.dates.length > 0
      ? value.replace(DATE, " ")
      : value
  );
  const title = eligible.filter((source) =>
    candidateTitle(source.fileName) === targetTitle ||
    candidateTitle(source.sourceName) === targetTitle);
  if (title.length > 0) {
    return { candidateSourceIds: title.map((source) => source.sourceId), matchKind: "normalized_title" };
  }

  const maximum = typoMaximum(targetTitle);
  if (maximum === 0) return { candidateSourceIds: [], matchKind: "none" };
  const scored = eligible.map((source) => ({
    sourceId: source.sourceId,
    score: Math.min(
      distance(targetTitle, candidateTitle(source.fileName), maximum),
      distance(targetTitle, candidateTitle(source.sourceName), maximum)
    )
  })).filter((candidate) => candidate.score <= maximum);
  const best = Math.min(...scored.map((candidate) => candidate.score));
  return Number.isFinite(best)
    ? {
        candidateSourceIds: scored.filter((candidate) => candidate.score === best)
          .map((candidate) => candidate.sourceId),
        matchKind: "fuzzy"
      }
    : { candidateSourceIds: [], matchKind: "none" };
}

/**
 * Resolves user target labels from admitted Source metadata only. Extra object
 * properties are deliberately ignored, so passage/body text cannot influence
 * identity resolution.
 */
export function resolveKnowledgePlannerTargets(input: Readonly<{
  sources: readonly KnowledgePlannerSourceIdentity[];
  targetNames: readonly string[];
}>): KnowledgePlannerTargetResolution | null {
  const sources = validateSources(input.sources);
  const targetNames = unique(input.targetNames.map((value) =>
    boundedCanonicalText(value, 160)).filter((value): value is string => value !== null));
  if (targetNames.length === 0) return null;
  if (targetNames.length > KNOWLEDGE_PLANNER_TARGET_MAXIMUM) {
    throw new Error("knowledge_planner_target_count_invalid");
  }

  const targets: KnowledgePlannerTargetMatch[] = targetNames.map((targetName) => {
    const matched = candidatesForTarget(targetName, sources);
    const candidateSourceIds = unique(matched.candidateSourceIds)
      .slice(0, KNOWLEDGE_PLANNER_TARGET_CANDIDATE_MAXIMUM);
    return {
      candidateSourceIds,
      matchKind: matched.matchKind,
      outcome: candidateSourceIds.length === 0
        ? "not_found" as const
        : matched.matchKind === "fuzzy" || candidateSourceIds.length > 1
          ? "ambiguous" as const
          : "resolved" as const,
      targetName
    };
  });
  const hasAmbiguity = targets.some((target) => target.outcome === "ambiguous");
  const hasMissing = targets.some((target) => target.outcome === "not_found");
  const targetSourceIds = hasAmbiguity || hasMissing
    ? []
    : unique(targets.flatMap((target) => target.candidateSourceIds));
  return {
    outcome: hasAmbiguity
      ? "ambiguous"
      : hasMissing ? "not_found" : targets.length === 1 ? "resolved" : "resolved_many",
    targetSourceIds,
    targets
  };
}

/** Returns exact admitted metadata labels mentioned in a query, never body hits. */
export function knowledgePlannerMetadataMentions(input: Readonly<{
  query: string;
  sources: readonly KnowledgePlannerSourceIdentity[];
}>): string[] {
  const sources = validateSources(input.sources);
  const query = comparableText(input.query);
  const matches: Array<Readonly<{ end: number; label: string; start: number }>> = [];
  for (const source of sources) {
    for (const label of [source.fileName, source.sourceName, source.sourceAlias]) {
      const comparable = comparableText(label);
      if (comparable.length < 2) continue;
      let start = query.indexOf(comparable);
      while (start >= 0) {
        const before = start === 0 ? " " : query[start - 1]!;
        const after = start + comparable.length >= query.length
          ? " "
          : query[start + comparable.length]!;
        const beforeBoundary = !/[\p{L}\p{N}]/u.test(comparable[0]!) ||
          !/[\p{L}\p{N}]/u.test(before);
        const afterBoundary = !/[\p{L}\p{N}]/u.test(comparable.at(-1)!) ||
          !/[\p{L}\p{N}]/u.test(after);
        if (beforeBoundary && afterBoundary) {
          matches.push({ end: start + comparable.length, label, start });
        }
        start = query.indexOf(comparable, start + comparable.length);
      }
    }
  }
  matches.sort((left, right) => left.start - right.start ||
    (right.end - right.start) - (left.end - left.start) || left.label.localeCompare(right.label));
  const selected: typeof matches = [];
  for (const match of matches) {
    if (selected.some((entry) => match.start < entry.end && entry.start < match.end)) continue;
    selected.push(match);
  }
  return unique(selected.sort((left, right) => left.start - right.start).map((match) => match.label));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeKnowledgePlannerTargetResolution(
  value: unknown
): KnowledgePlannerTargetResolution | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !exactKeys(value, ["outcome", "targetSourceIds", "targets"]) ||
    value.outcome !== "resolved" && value.outcome !== "resolved_many" &&
      value.outcome !== "ambiguous" && value.outcome !== "not_found" ||
    !Array.isArray(value.targetSourceIds) || value.targetSourceIds.length > 8 ||
    value.targetSourceIds.some((sourceId) => typeof sourceId !== "string" || !UUID.test(sourceId)) ||
    new Set(value.targetSourceIds).size !== value.targetSourceIds.length ||
    !Array.isArray(value.targets) || value.targets.length < 1 ||
    value.targets.length > KNOWLEDGE_PLANNER_TARGET_MAXIMUM) return undefined;
  const targets: KnowledgePlannerTargetMatch[] = [];
  for (const target of value.targets) {
    if (!isRecord(target) || !exactKeys(target, [
      "candidateSourceIds",
      "matchKind",
      "outcome",
      "targetName"
    ]) ||
      target.matchKind !== "alias" && target.matchKind !== "file_name" &&
        target.matchKind !== "fuzzy" && target.matchKind !== "none" &&
        target.matchKind !== "normalized_title" && target.matchKind !== "scope" &&
        target.matchKind !== "source_name" ||
      target.outcome !== "resolved" && target.outcome !== "ambiguous" &&
        target.outcome !== "not_found" ||
      !boundedCanonicalText(target.targetName, 160) ||
      !Array.isArray(target.candidateSourceIds) ||
      target.candidateSourceIds.length > KNOWLEDGE_PLANNER_TARGET_CANDIDATE_MAXIMUM ||
      target.candidateSourceIds.some((sourceId) => typeof sourceId !== "string" || !UUID.test(sourceId)) ||
      new Set(target.candidateSourceIds).size !== target.candidateSourceIds.length ||
      (target.outcome === "resolved") !== (target.candidateSourceIds.length === 1 &&
        target.matchKind !== "fuzzy" && target.matchKind !== "none") ||
      target.outcome === "ambiguous" && (target.candidateSourceIds.length < 1 ||
        target.matchKind === "none") ||
      target.outcome === "not_found" && (target.candidateSourceIds.length !== 0 ||
        target.matchKind !== "none") ||
      (target.matchKind === "fuzzy" || target.matchKind === "scope") &&
        target.outcome !== "ambiguous" ||
      target.matchKind === "scope" && target.candidateSourceIds.length < 2) return undefined;
    targets.push(target as unknown as KnowledgePlannerTargetMatch);
  }
  if (new Set(targets.map((target) => target.targetName)).size !== targets.length) return undefined;
  const targetSourceIds = value.targetSourceIds as string[];
  const expectedSourceIds = unique(targets.flatMap((target) => target.candidateSourceIds));
  const hasAmbiguity = targets.some((target) => target.outcome === "ambiguous");
  const hasMissing = targets.some((target) => target.outcome === "not_found");
  const expectedOutcome: KnowledgePlannerTargetOutcome = hasAmbiguity
    ? "ambiguous"
    : hasMissing ? "not_found" : targets.length === 1 ? "resolved" : "resolved_many";
  const executionIds = hasAmbiguity || hasMissing ? [] : expectedSourceIds;
  if (value.outcome !== expectedOutcome ||
    executionIds.length !== targetSourceIds.length ||
    executionIds.some((sourceId, index) => targetSourceIds[index] !== sourceId)) return undefined;
  return value as unknown as KnowledgePlannerTargetResolution;
}
