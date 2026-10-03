import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";

export const MEMORY_CLEANUP_QUALIFICATION_ACK = "DISPOSABLE_PAID_MEMORY_CLEANUP";
export const MEMORY_CLEANUP_QUALIFICATION_VERSION = 1;
const MAX_PRIVATE_FILE_BYTES = 2 * 1024 * 1024;
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);

export const cleanupQualificationFixtureSchema = z.object({
  version: z.literal(1),
  runId: z.string().regex(/^[a-f0-9]{12}$/u),
  corpus: z.enum(["PRIVATE", "SYNTHETIC"]),
  userId: identifier,
  assertions: z.array(z.object({
    id: identifier,
    factIds: z.array(identifier).min(1).max(100),
    expected: z.enum(["RETAIN", "RETIRE", "OBSERVE"]),
    protected: z.boolean(),
    dated: z.boolean().optional()
  }).strict()).min(1).max(200)
}).strict().superRefine((fixture, context) => {
  const ids = fixture.assertions.map(({ id }) => id);
  const facts = fixture.assertions.flatMap(({ factIds }) => factIds);
  if (new Set(ids).size !== ids.length || new Set(facts).size !== facts.length ||
    fixture.assertions.some((item) => item.protected && item.expected !== "RETAIN")) {
    context.addIssue({ code: "custom", message: "invalid_qualification_assertions" });
  }
});
export type CleanupQualificationFixture = z.infer<typeof cleanupQualificationFixtureSchema>;

export type CleanupQualificationOptions = Readonly<{
  mode: "preview" | "apply";
  fixture: string;
  plan: string;
  output: string;
  baselinePlan?: string;
}> | Readonly<{ mode: "seed"; fixture: string; output: string; runId: string }>
  | Readonly<{ mode: "verify"; fixture: string; output: string; baselinePlan: string }>;

export function cleanupQualificationOptions(args: readonly string[]): CleanupQualificationOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !["--ack", "--mode", "--fixture", "--plan", "--output", "--run-id", "--baseline-plan"].includes(key) ||
      !value || values.has(key)) throw new Error("memory_cleanup_arguments_invalid");
    values.set(key, value);
  }
  if (values.get("--ack") !== MEMORY_CLEANUP_QUALIFICATION_ACK) {
    throw new Error("memory_cleanup_disposable_ack_required");
  }
  const mode = values.get("--mode");
  const fixture = values.get("--fixture");
  const plan = values.get("--plan");
  const output = values.get("--output");
  const baselinePlan = values.get("--baseline-plan");
  if (mode === "verify" && fixture && output && baselinePlan && !plan && !values.has("--run-id") &&
    [fixture, output, baselinePlan].every(isAbsolute) && new Set([fixture, output, baselinePlan]).size === 3) {
    return { mode, fixture, output, baselinePlan };
  }
  if (mode === "seed" && fixture && output && !plan && !baselinePlan &&
    [fixture, output].every(isAbsolute) && fixture !== output &&
    /^[a-f0-9]{12}$/u.test(values.get("--run-id") ?? "")) {
    return { mode, fixture, output, runId: values.get("--run-id")! };
  }
  if ((mode !== "preview" && mode !== "apply") || !fixture || !plan || !output ||
    values.has("--run-id") ||
    (baselinePlan !== undefined && (!isAbsolute(baselinePlan) || [fixture, plan, output].includes(baselinePlan))) ||
    ![fixture, plan, output].every(isAbsolute) || new Set([fixture, plan, output]).size !== 3) {
    throw new Error("memory_cleanup_arguments_invalid");
  }
  return { mode, fixture, plan, output, ...(baselinePlan ? { baselinePlan } : {}) };
}

/** Checked before importing any server singleton or opening a database. */
export function cleanupQualificationDatabase(
  environment: Readonly<Record<string, string | undefined>>,
  runId: string
): URL {
  if (environment.AIQSA_TEST_MODE !== "1" ||
    environment.AIQSA_LOCAL_DEV_PROFILE_DISABLED !== "1" || environment.NODE_ENV === "production") {
    throw new Error("memory_cleanup_disposable_environment_required");
  }
  let database: URL;
  try { database = new URL(environment.AIQSA_MEMORY_CLEANUP_DATABASE_URL ?? ""); }
  catch { throw new Error("memory_cleanup_database_invalid"); }
  if (!/^[a-f0-9]{12}$/u.test(runId) || database.protocol !== "postgresql:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
    database.username !== "aiqsa" || !database.password ||
    !/^\d{1,5}$/u.test(database.port) || Number(database.port) < 1 ||
    Number(database.port) > 65_535 ||
    database.pathname !== `/aiqsa_memory_qualification_${runId}` || database.hash ||
    [...database.searchParams.keys()].some((key) => key !== "schema") ||
    database.searchParams.getAll("schema").length !== 1 ||
    database.searchParams.get("schema") !== "public") {
    throw new Error("memory_cleanup_database_not_disposable");
  }
  if (environment.DATABASE_URL && environment.DATABASE_URL !== database.toString()) {
    throw new Error("memory_cleanup_database_authority_conflict");
  }
  return database;
}

export function cleanupQualificationHash(value: unknown): string {
  function canonical(item: unknown): string {
    if (item instanceof Date) return JSON.stringify(item.toISOString());
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item && typeof item === "object") {
      return `{${Object.entries(item).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
    }
    return JSON.stringify(item) ?? "null";
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function ownedPrivate(stat: Awaited<ReturnType<typeof lstat>>): boolean {
  return (Number(stat.mode) & 0o077) === 0 &&
    (typeof process.getuid !== "function" || Number(stat.uid) === process.getuid());
}

/** No symlinks, shared-readable files, or unbounded private JSON inputs. */
export async function readCleanupQualificationFile(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new Error("memory_cleanup_private_file_invalid");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !ownedPrivate(stat) ||
      stat.size < 1 || stat.size > MAX_PRIVATE_FILE_BYTES) {
      throw new Error("memory_cleanup_private_file_invalid");
    }
    const content = Buffer.alloc(MAX_PRIVATE_FILE_BYTES + 1);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_PRIVATE_FILE_BYTES) throw new Error("invalid_size");
    return JSON.parse(content.subarray(0, offset).toString("utf8")) as unknown;
  } catch {
    throw new Error("memory_cleanup_private_file_invalid");
  } finally { await handle?.close(); }
}

/** Reports and plan manifests never overwrite an earlier paid attempt. */
export async function writeCleanupQualificationFile(path: string, value: unknown): Promise<void> {
  const reserved = await reserveCleanupQualificationFile(path);
  try { await reserved.write(value); }
  finally { await reserved.close(); }
}

/** Reserve before a fixture mutation; an existing path fails without new state. */
export async function reserveCleanupQualificationFile(path: string) {
  if (!isAbsolute(path)) throw new Error("memory_cleanup_output_invalid");
  try {
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || !ownedPrivate(parent)) throw new Error("memory_cleanup_output_parent_not_private");
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let written = false;
    return {
      async write(value: unknown) {
        if (written) throw new Error("memory_cleanup_output_already_written");
        written = true;
        try {
          await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
          await handle.sync();
        } catch { throw new Error("memory_cleanup_output_write_failed"); }
      },
      close: () => handle.close()
    };
  } catch (error) {
    if (error instanceof Error && error.message === "memory_cleanup_output_parent_not_private") throw error;
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "EEXIST") throw new Error("memory_cleanup_output_exists");
    if (code === "ENOENT") throw new Error("memory_cleanup_output_parent_missing");
    if (code === "EACCES" || code === "EPERM") throw new Error("memory_cleanup_output_access_denied");
    throw new Error("memory_cleanup_output_invalid");
  }
}

export async function withCleanupQualificationOutputFiles<T>(
  paths: Readonly<{ report: string; plan?: string }>,
  run: (files: Readonly<{ report: Awaited<ReturnType<typeof reserveCleanupQualificationFile>>;
    plan?: Awaited<ReturnType<typeof reserveCleanupQualificationFile>> }>) => Promise<T>
): Promise<T> {
  const report = await reserveCleanupQualificationFile(paths.report);
  let plan: Awaited<ReturnType<typeof reserveCleanupQualificationFile>> | undefined;
  try {
    if (paths.plan) plan = await reserveCleanupQualificationFile(paths.plan);
    return await run({ report, plan });
  } finally { await plan?.close(); await report.close(); }
}

export function freshCleanupQualificationOwner(runId: string): string {
  if (!/^[a-f0-9]{12}$/u.test(runId)) throw new Error("memory_cleanup_run_id_invalid");
  return `memory-cleanup-synthetic-${runId}-${randomUUID()}`;
}

export const cleanupQualificationPlanSchema = z.object({
  version: z.literal(1),
  runId: z.string().regex(/^[a-f0-9]{12}$/u),
  fixtureHash: hash,
  databaseHash: hash,
  userId: identifier,
  jobId: identifier,
  inputHash: hash,
  acceptedOutputHash: hash,
  sourceSnapshotHash: hash,
  sourceDocumentsHash: hash,
  protectedSnapshotHash: hash,
  reviewedFactIds: z.array(identifier).min(1).max(16),
  before: z.array(z.object({
    factId: identifier,
    currentVersionId: identifier.nullable(),
    active: z.boolean(),
    protected: z.boolean(),
    snapshotHash: hash
  }).strict()).max(10_000),
  providerCalls: z.number().int().positive().max(2)
}).strict();
export type CleanupQualificationPlan = z.infer<typeof cleanupQualificationPlanSchema>;

export function assertCleanupQualificationPlan(
  plan: CleanupQualificationPlan,
  fixture: CleanupQualificationFixture,
  database: URL
): void {
  if (plan.runId !== fixture.runId || plan.userId !== fixture.userId ||
    plan.fixtureHash !== cleanupQualificationHash(fixture) ||
    plan.databaseHash !== cleanupQualificationHash({
      host: database.hostname, port: database.port, name: database.pathname, role: database.username
    })) throw new Error("memory_cleanup_plan_identity_mismatch");
}

/** Deliberately independent of production/private text and extraction wording. */
export const MEMORY_CLEANUP_SYNTHETIC_CORPUS = Object.freeze([
  { id: "ru_durable", language: "ru", text: "Я много лет работаю реставратором книг и предпочитаю подробные письменные инструкции.", expected: "RETAIN", sourceMode: "AUTOMATIC", pinned: false },
  { id: "en_durable", language: "en", text: "I have a severe sesame allergy and always check ingredients before eating.", expected: "RETAIN", sourceMode: "AUTOMATIC", pinned: false },
  { id: "ru_ongoing", language: "ru", text: "До конца следующего года я каждую среду хожу на вечерние курсы итальянского.", expected: "RETAIN", sourceMode: "AUTOMATIC", pinned: false },
  { id: "en_ongoing", language: "en", text: "I am studying for a professional certification over the next six months.", expected: "RETAIN", sourceMode: "AUTOMATIC", pinned: false },
  { id: "ru_ephemeral", language: "ru", text: "Сейчас индикатор загрузки показывает сорок процентов, минуту назад было тридцать.", expected: "RETIRE", sourceMode: "AUTOMATIC", pinned: false },
  { id: "en_ephemeral", language: "en", text: "The elevator has just arrived; I am stepping inside now.", expected: "RETIRE", sourceMode: "AUTOMATIC", pinned: false },
  { id: "ru_explicit", language: "ru", text: "Запомни: номер моего сегодняшнего шкафчика — 27.", expected: "RETAIN", sourceMode: "EXPLICIT", pinned: false },
  { id: "en_explicit", language: "en", text: "Remember that today's rehearsal room is called Cedar.", expected: "RETAIN", sourceMode: "EXPLICIT", pinned: false },
  { id: "en_manual", language: "en", text: "The temporary rehearsal room is called Cedar.", expected: "RETAIN", sourceMode: "AUTOMATIC", pinned: false, manuallyEdited: true },
  { id: "ru_pinned", language: "ru", text: "На сегодняшнюю репетицию я принёс зелёную папку.", expected: "RETAIN", sourceMode: "AUTOMATIC", pinned: true },
  { id: "en_pinned", language: "en", text: "Today I placed the spare rehearsal badge in the orange envelope.", expected: "RETAIN", sourceMode: "AUTOMATIC", pinned: true },
  { id: "en_duplicate_a", language: "en", text: "I cycle to the workshop on weekdays.", expected: "RETAIN", sourceMode: "AUTOMATIC", pinned: false },
  { id: "en_duplicate_b", language: "en", text: "On working days I travel to my workshop by bicycle.", expected: "RETAIN", sourceMode: "AUTOMATIC", pinned: false },
  { id: "ru_local_option", language: "ru", text: "Только модели с двумя разъёмами USB-C.",
    context: ["Помоги выбрать док-станцию для этого ноутбука.", "Сколько разъёмов USB-C нужно для этой покупки?"],
    expected: "RETIRE", sourceMode: "AUTOMATIC", pinned: false },
  { id: "en_local_option", language: "en", text: "Only the compact one that fits this carrying case.",
    context: ["Help me choose a microphone for tomorrow's recording kit.", "Which size should I consider for this kit?"],
    expected: "RETIRE", sourceMode: "AUTOMATIC", pinned: false },
  { id: "ru_local_safety", language: "ru", text: "Да, без риска испортить поверхность.",
    context: ["Подбери средство, чтобы сегодня убрать это пятно со стола.", "Один из вариантов может повредить покрытие. Исключить его?"],
    expected: "RETIRE", sourceMode: "AUTOMATIC", pinned: false },
  { id: "en_local_safety", language: "en", text: "Yes, I want the safe option.",
    context: ["Choose a cleaning product for this spill on the borrowed camera case.", "One candidate might damage the finish. Should I leave it out?"],
    expected: "RETIRE", sourceMode: "AUTOMATIC", pinned: false },
  { id: "ru_local_comfort", language: "ru", text: "Тогда лучше тот, который меньше шумит.",
    context: ["Выбери один из этих двух вентиляторов для сегодняшней записи интервью.", "Оба подходят, но второй тише. Какой включить?"],
    expected: "RETIRE", sourceMode: "AUTOMATIC", pinned: false },
  { id: "en_local_comfort", language: "en", text: "The more comfortable option, please.",
    context: ["Pick one of these two folding chairs for tonight's guest speaker.", "Both fit the stage. Shall I choose the lighter chair or the more comfortable one?"],
    expected: "RETIRE", sourceMode: "AUTOMATIC", pinned: false },
  { id: "ru_recurring_constraint", language: "ru", text: "Из-за давней травмы кисти я всегда выбираю инструменты с толстой рукояткой, это постоянное требование.",
    context: ["Помоги выбрать новый садовый инструмент.", "Есть ли у тебя общие требования к инструментам?"],
    expected: "RETAIN", sourceMode: "AUTOMATIC", pinned: false },
  { id: "en_recurring_constraint", language: "en", text: "I have had chronic sound sensitivity for years, so I consistently choose quiet appliances in every room.",
    context: ["Help me choose a fan.", "Do you have any general requirements for household appliances?"],
    expected: "RETAIN", sourceMode: "AUTOMATIC", pinned: false }
] as const);

/** Long-term cleanup scenarios from the v3 acceptance corpus. Each scenario is
 * one chat; a version cites `quote` inside its message (the whole message by
 * default) and the last version of a fact is current. */
export type MemoryCleanupLifecycleFact = Readonly<{
  id: string;
  expected: "RETAIN" | "RETIRE";
  versions: readonly Readonly<{
    message: number; statement: string; quote?: string;
    usefulness?: "DURABLE" | "ONGOING" | "EPISODIC"; remembered?: boolean;
  }>[];
  dated?: boolean;
  /** A settled v2 KEEP EPISODIC review predates this pass. */
  priorKeep?: boolean;
}>;
export type MemoryCleanupLifecycleScenario = Readonly<{
  language: "ru" | "en"; messages: readonly string[]; facts: readonly MemoryCleanupLifecycleFact[];
}>;
const single = (language: "ru" | "en", id: string, text: string, expected: "RETAIN" | "RETIRE",
  options: Partial<Pick<MemoryCleanupLifecycleFact, "dated" | "priorKeep">> & Readonly<{
    usefulness?: "DURABLE" | "ONGOING" | "EPISODIC"; remembered?: boolean;
  }> = {}): MemoryCleanupLifecycleScenario => ({ language, messages: [text], facts: [{ id, expected,
  versions: [{ message: 0, statement: text, usefulness: options.usefulness, remembered: options.remembered }],
  dated: options.dated, priorKeep: options.priorKeep }] });
export const MEMORY_CLEANUP_LIFECYCLE_CORPUS: readonly MemoryCleanupLifecycleScenario[] = Object.freeze([
  single("ru", "ru_v3_episode_episodic", "Вчера я ходил на концерт джазового трио в филармонии.", "RETIRE", { usefulness: "EPISODIC" }),
  single("en", "en_v3_episode_episodic", "Yesterday I went to a jazz trio concert at the philharmonic.", "RETIRE", { usefulness: "EPISODIC" }),
  single("ru", "ru_v3_episode_unlabeled", "В прошлую субботу я заблудился в новом торговом центре.", "RETIRE"),
  single("en", "en_v3_episode_unlabeled", "Last Saturday I got lost in the new shopping mall.", "RETIRE"),
  single("ru", "ru_v3_mislabeled_durable", "Сегодня утром я пролил кофе на клавиатуру.", "RETIRE", { usefulness: "DURABLE" }),
  single("en", "en_v3_mislabeled_durable", "This morning I spilled coffee on my keyboard.", "RETIRE", { usefulness: "DURABLE" }),
  single("ru", "ru_v3_mislabeled_ongoing", "На этой неделе я жду доставку нового офисного кресла.", "RETIRE", { usefulness: "ONGOING" }),
  single("en", "en_v3_mislabeled_ongoing", "This week I am waiting for a new office chair to be delivered.", "RETIRE", { usefulness: "ONGOING" }),
  single("ru", "ru_v3_prior_keep", "В прошлом месяце я был на свадьбе друга в Казани.", "RETIRE", { usefulness: "EPISODIC", priorKeep: true }),
  single("en", "en_v3_prior_keep", "Last month I attended a friend's wedding in Denver.", "RETIRE", { usefulness: "EPISODIC", priorKeep: true }),
  { language: "ru", messages: ["Посылка придёт во вторник.", "Уточнение: посылка теперь придёт в четверг."], facts: [{
    id: "ru_v3_two_versions", expected: "RETIRE", versions: [
      { message: 0, statement: "Посылка придёт во вторник.", usefulness: "ONGOING" },
      { message: 1, statement: "Посылка придёт в четверг.", quote: "посылка теперь придёт в четверг.", usefulness: "ONGOING" }] }] },
  { language: "en", messages: ["The parcel arrives on Tuesday.", "Correction: the parcel now arrives on Thursday."], facts: [{
    id: "en_v3_two_versions", expected: "RETIRE", versions: [
      { message: 0, statement: "The parcel arrives on Tuesday.", usefulness: "ONGOING" },
      { message: 1, statement: "The parcel arrives on Thursday.", quote: "the parcel now arrives on Thursday.", usefulness: "ONGOING" }] }] },
  { language: "ru", messages: ["Вчера я был у стоматолога, а потом обедал с Анной в кафе."], facts: [
    { id: "ru_v3_overlap_dentist", expected: "RETIRE", versions: [{ message: 0, statement: "Вчера я был у стоматолога.",
      quote: "Вчера я был у стоматолога, а потом обедал", usefulness: "EPISODIC" }] },
    { id: "ru_v3_overlap_lunch", expected: "RETIRE", versions: [{ message: 0, statement: "Вчера я обедал с Анной в кафе.",
      quote: "а потом обедал с Анной в кафе.", usefulness: "EPISODIC" }] }] },
  { language: "en", messages: ["Yesterday I saw the dentist and then had lunch with Anna at the cafe."], facts: [
    { id: "en_v3_overlap_dentist", expected: "RETIRE", versions: [{ message: 0, statement: "Yesterday I saw the dentist.",
      quote: "Yesterday I saw the dentist and then had lunch", usefulness: "EPISODIC" }] },
    { id: "en_v3_overlap_lunch", expected: "RETIRE", versions: [{ message: 0, statement: "Yesterday I had lunch with Anna at the cafe.",
      quote: "and then had lunch with Anna at the cafe.", usefulness: "EPISODIC" }] }] },
  { language: "ru", messages: ["Я вегетарианец уже десять лет; вчера я попробовал новое кафе с фалафелем."], facts: [
    { id: "ru_v3_neighbour_lasting", expected: "RETAIN", versions: [{ message: 0, statement: "Я вегетарианец уже десять лет.",
      quote: "Я вегетарианец уже десять лет", usefulness: "DURABLE" }] },
    { id: "ru_v3_neighbour_episode", expected: "RETIRE", versions: [{ message: 0, statement: "Вчера я попробовал новое кафе с фалафелем.",
      quote: "вчера я попробовал новое кафе с фалафелем.", usefulness: "EPISODIC" }] }] },
  { language: "en", messages: ["I have been vegetarian for ten years; yesterday I tried a new falafel place."], facts: [
    { id: "en_v3_neighbour_lasting", expected: "RETAIN", versions: [{ message: 0, statement: "I have been vegetarian for ten years.",
      quote: "I have been vegetarian for ten years", usefulness: "DURABLE" }] },
    { id: "en_v3_neighbour_episode", expected: "RETIRE", versions: [{ message: 0, statement: "Yesterday I tried a new falafel place.",
      quote: "yesterday I tried a new falafel place.", usefulness: "EPISODIC" }] }] },
  single("ru", "ru_v3_dated", "Сегодня в девять утра у меня был приём у окулиста.", "RETIRE", { usefulness: "EPISODIC", dated: true }),
  single("en", "en_v3_dated", "This morning at nine I had an appointment with the eye doctor.", "RETIRE", { usefulness: "EPISODIC", dated: true }),
  single("ru", "ru_v3_common_habit", "Я регулярно ем хлеб.", "RETIRE", { usefulness: "DURABLE" }),
  single("en", "en_v3_common_habit", "I regularly eat bread.", "RETIRE", { usefulness: "DURABLE" }),
  single("ru", "ru_v3_remembered", "Запомни: сегодня я поставил машину на третьем уровне парковки.", "RETAIN",
    { usefulness: "EPISODIC", remembered: true }),
  single("en", "en_v3_remembered", "Remember that today I parked on level three of the garage.", "RETAIN",
    { usefulness: "EPISODIC", remembered: true })
]);

/** Exact span of a lifecycle version inside its scenario message. */
export function memoryCleanupLifecycleSpan(scenario: MemoryCleanupLifecycleScenario,
  version: MemoryCleanupLifecycleFact["versions"][number]): Readonly<{ start: number; end: number; text: string }> {
  const text = scenario.messages[version.message];
  const quote = version.quote ?? text;
  const start = text === undefined ? -1 : text.indexOf(quote);
  if (text === undefined || start < 0) throw new Error("memory_cleanup_lifecycle_corpus_invalid");
  return { start, end: start + quote.length, text };
}

export const MEMORY_CLEANUP_QUALIFICATION_REASONS = Object.freeze([
  "pending_relation", "evidence_without_offsets", "source_changed",
  "unreviewable_context", "statement_too_long", "evidence_not_current"
] as const);
export type CleanupQualificationReason = (typeof MEMORY_CLEANUP_QUALIFICATION_REASONS)[number];

/** Old KEEP is not current-policy coverage. Supported committed removals remain
 * provenance for rows already retired; they never authorize another call.
 * Current-policy blocked and unreviewable sources are settled for this pass,
 * counted by fixed reason and never reported as reviewed or removed. */
export function summarizeCleanupQualificationReviews(input: Readonly<{
  currentPolicy: string;
  supportedPolicies: readonly string[];
  succeededJobIds: readonly string[];
  activeFactIds: readonly string[];
  versions: readonly Readonly<{ id: string; factId: string }>[];
  reviews: readonly Readonly<{ factVersionId: string; memoryJobId: string | null; policyVersion: string;
    disposition: string; reasonCode?: string | null }>[];
}>) {
  const succeeded = new Set(input.succeededJobIds);
  const factByVersion = new Map(input.versions.map((item) => [item.id, item.factId]));
  const supported = new Set(input.supportedPolicies);
  const active = new Set(input.activeFactIds);
  const reviewed = new Set<string>();
  const removed = new Set<string>();
  const settled = new Set<string>();
  const outcomes = { kept: 0, rejected: 0, removed: 0, blocked: 0, unreviewable: 0 };
  const reasons = Object.fromEntries(MEMORY_CLEANUP_QUALIFICATION_REASONS.map((reason) => [reason, 0])) as Record<CleanupQualificationReason, number>;
  for (const item of input.reviews) {
    const factId = factByVersion.get(item.factVersionId);
    if (!factId || !supported.has(item.policyVersion)) continue;
    const current = item.policyVersion === input.currentPolicy;
    if (current && (item.disposition === "BLOCKED" || item.disposition === "UNREVIEWABLE") &&
      (item.memoryJobId === null || succeeded.has(item.memoryJobId))) {
      settled.add(factId);
      outcomes[item.disposition === "BLOCKED" ? "blocked" : "unreviewable"]++;
      if (MEMORY_CLEANUP_QUALIFICATION_REASONS.some((reason) => reason === item.reasonCode)) {
        reasons[item.reasonCode as CleanupQualificationReason]++;
      }
      continue;
    }
    if (item.memoryJobId === null || !succeeded.has(item.memoryJobId)) continue;
    if (item.disposition === "REMOVED") {
      removed.add(factId);
      if (current) outcomes.removed++;
      if (!active.has(factId) || current) reviewed.add(factId);
    } else if (current && ["KEEP", "REJECTED"].includes(item.disposition)) {
      reviewed.add(factId);
      outcomes[item.disposition === "KEEP" ? "kept" : "rejected"]++;
    }
  }
  return { reviewed, removed, settled, outcomes, reasons, jobs: [...succeeded] };
}

export type CleanupQualificationFactState = Readonly<{
  factId: string;
  currentVersionId: string | null;
  active: boolean;
  protected: boolean;
  snapshotHash: string;
}>;

export function assertCleanupQualificationOwnership(
  fixture: CleanupQualificationFixture,
  states: readonly CleanupQualificationFactState[]
): void {
  const byId = new Map(states.map((state) => [state.factId, state]));
  for (const assertion of fixture.assertions) {
    for (const id of assertion.factIds) {
      const state = byId.get(id);
      if (!state || !state.active || state.protected !== assertion.protected) {
        throw new Error("memory_cleanup_fixture_owner_or_protection_mismatch");
      }
    }
  }
}

export function evaluateCleanupQualification(
  fixture: CleanupQualificationFixture,
  before: readonly CleanupQualificationFactState[],
  after: readonly CleanupQualificationFactState[],
  reviewedFactIds?: ReadonlySet<string>
): Readonly<{ checked: number; passed: number; protected: number; retained: number; retired: number;
  erroneousRemovals: number; remainingRetire: number }> {
  const previous = new Map(before.map((state) => [state.factId, state]));
  const current = new Map(after.map((state) => [state.factId, state]));
  let checked = 0;
  let passed = 0;
  let retained = 0;
  let retired = 0;
  let protectedCount = 0;
  let erroneousRemovals = 0;
  let remainingRetire = 0;
  // Protect every explicit/manual/pinned row, including rows outside a rubric.
  for (const state of before) {
    if (state.protected) {
      protectedCount++;
      if (current.get(state.factId)?.snapshotHash !== state.snapshotHash) {
        throw new Error("memory_cleanup_protected_memory_changed");
      }
    }
  }
  for (const assertion of fixture.assertions) {
    for (const id of assertion.factIds) {
      if (reviewedFactIds && !reviewedFactIds.has(id) && !assertion.protected) continue;
      const was = previous.get(id);
      const now = current.get(id);
      if (!was?.active) throw new Error("memory_cleanup_fixture_source_missing");
      if (now?.active) retained++;
      else retired++;
      if (assertion.expected === "OBSERVE") continue;
      checked++;
      if (assertion.expected === "RETAIN" ? now?.active && now.currentVersionId === was.currentVersionId : !now?.active) passed++;
      else if (assertion.expected === "RETAIN") erroneousRemovals++;
      else remainingRetire++;
    }
  }
  return { checked, passed, protected: protectedCount, retained, retired, erroneousRemovals, remainingRetire };
}

/** A later batch may see only removals attested by committed earlier reviews. */
export function assertCleanupQualificationContinuation(
  before: readonly CleanupQualificationFactState[],
  current: readonly CleanupQualificationFactState[],
  committedRemovedIds: ReadonlySet<string>
): void {
  const now = new Map(current.map((item) => [item.factId, item]));
  if (before.length !== current.length || current.some((item) => !before.some((old) => old.factId === item.factId))) {
    throw new Error("memory_cleanup_baseline_inventory_changed");
  }
  for (const old of before) {
    const item = now.get(old.factId)!;
    if (old.protected && item.snapshotHash !== old.snapshotHash) throw new Error("memory_cleanup_protected_memory_changed");
    if (old.active && !item.active && !committedRemovedIds.has(old.factId)) {
      throw new Error("memory_cleanup_unattested_prior_removal");
    }
    if (old.active && item.active && old.currentVersionId !== item.currentVersionId) {
      throw new Error("memory_cleanup_baseline_version_changed");
    }
  }
}

export function cleanupQualificationFailureCode(error: unknown): string {
  return error instanceof Error && /^memory_[a-z0-9_]{1,88}$/u.test(error.message)
    ? error.message : "memory_cleanup_qualification_failed";
}

export function cleanupQualificationFailureDiagnostic(error: unknown, phase: string) {
  const result: { code: string; phase: string; prismaCode?: string; databaseCode?: string } = {
    code: cleanupQualificationFailureCode(error),
    phase: /^[a-z][a-z0-9_]{0,47}$/u.test(phase) ? phase : "unknown"
  };
  if (!error || typeof error !== "object") return result;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  if (typeof candidate.code === "string" && /^P\d{4}$/u.test(candidate.code)) result.prismaCode = candidate.code;
  if (typeof candidate.meta?.code === "string" && /^[0-9A-Z]{5}$/u.test(candidate.meta.code)) {
    result.databaseCode = candidate.meta.code;
  }
  return result;
}
