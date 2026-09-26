import type { TokenContentClass } from "./tokenEstimate";

/**
 * Calibration fixtures shared by contextBudget.test.ts and
 * scripts/calibrate-token-estimate.ts. Synthetic, deterministic and free of
 * private content. Changing a fixture invalidates its recorded counts.
 */
export type TokenEstimateFixture = Readonly<{
  contentClass: TokenContentClass;
  name: string;
  text: string;
}>;

const ENGLISH_PROSE = `The quarterly planning review started with a short summary of the incidents that affected the billing service in August. Two of them were caused by a configuration change that was deployed without a staged rollout, and one was a capacity problem during the end-of-month invoice run. The team agreed that every configuration change must pass the same review as a code change, and that the rollout tool should refuse a production deployment when the canary stage was skipped. Maria asked whether the new rule would slow down urgent fixes; the answer was that an emergency path already exists, but it requires a named approver and a follow-up ticket within one business day.

The second topic was the migration of the reporting pipeline. The current nightly job reads about forty million rows, aggregates them by customer and region, and writes the results into a warehouse table that the finance dashboards query every morning. The job has become fragile because a single slow partition delays the whole run, and on three occasions last month the dashboards showed data that was a day old. The proposal is to split the job into independent regional tasks, publish each result as soon as it is ready, and mark the dashboard tiles with the time of the last successful update so that readers can see stale numbers instead of trusting them.

Several people raised concerns about cost. Running the regional tasks in parallel needs more workers for a short time, but the total compute time should fall, because failed runs will no longer be retried from the beginning. The estimate presented at the meeting was a nine percent increase in peak capacity and a fifteen percent decrease in monthly spend, with the caveat that the numbers depend on how evenly the data is distributed across regions. Daniel will collect a week of partition statistics before the design is final.

The last part of the meeting covered hiring and onboarding. Two engineers join the platform team in October, and the group discussed which parts of the documentation are out of date. The runbook for database failover still describes the old replication setup, the diagram of the message queues does not show the dead-letter topics, and the onboarding checklist asks new people to request access to a system that was retired in the spring. Each owner will review their section and send corrections before the end of the month, and the updated checklist will be tested by the new engineers during their first week.

Action items: update the rollout policy and announce it to all teams; prepare the regional job design with partition statistics; review the failover runbook; replace the queue diagram; and confirm the budget impact with finance after the first two weeks of the new pipeline.`;

const RUSSIAN_PROSE = `Квартальное совещание по планированию началось с краткого обзора инцидентов, которые затронули платёжный сервис в августе. Два из них произошли из-за изменения конфигурации, выкаченного без поэтапного развёртывания, а третий был связан с нехваткой мощности во время ежемесячного выставления счетов. Команда договорилась, что любое изменение конфигурации проходит такое же ревью, как изменение кода, а инструмент развёртывания должен отказывать в выкатке на продакшен, если этап канареечной проверки был пропущен. Мария спросила, не замедлит ли новое правило срочные исправления; ответ был такой: экстренный путь уже существует, но он требует назначенного согласующего и задачи на разбор в течение одного рабочего дня.

Вторая тема касалась переноса конвейера отчётности. Текущая ночная задача читает около сорока миллионов строк, агрегирует их по клиентам и регионам и записывает результат в таблицу хранилища, к которой каждое утро обращаются финансовые панели. Задача стала хрупкой: одна медленная партиция задерживает весь запуск, и трижды в прошлом месяце панели показывали данные суточной давности. Предлагается разделить задачу на независимые региональные части, публиковать каждый результат сразу после готовности и отмечать плитки панели временем последнего успешного обновления, чтобы читатели видели устаревшие цифры, а не доверяли им.

Несколько участников высказали опасения по поводу стоимости. Параллельный запуск региональных задач ненадолго требует больше исполнителей, однако общее время вычислений должно сократиться, потому что упавшие запуски больше не будут повторяться с самого начала. На встрече прозвучала оценка: пиковая мощность вырастет на девять процентов, а ежемесячные расходы снизятся на пятнадцать процентов, при условии что данные распределены по регионам достаточно равномерно. Даниил соберёт статистику по партициям за неделю, прежде чем проект будет утверждён.

В последней части обсуждали найм и адаптацию новых сотрудников. В октябре в команду платформы придут два инженера, и группа разобрала, какие разделы документации устарели. Регламент переключения базы данных всё ещё описывает старую схему репликации, на схеме очередей сообщений нет топиков для необработанных сообщений, а чек-лист адаптации предлагает запросить доступ к системе, которую вывели из эксплуатации весной. Каждый владелец проверит свой раздел и пришлёт исправления до конца месяца, а обновлённый чек-лист проверят новые инженеры в первую неделю работы.

Итоги: обновить правила развёртывания и сообщить о них всем командам; подготовить проект региональной задачи со статистикой партиций; пересмотреть регламент переключения; заменить схему очередей; подтвердить влияние на бюджет вместе с финансовым отделом через две недели после запуска нового конвейера.`;

const TYPESCRIPT_CODE = `import { createHash } from "node:crypto";

export type CacheEntry<Value> = Readonly<{
  expiresAt: number;
  key: string;
  value: Value;
}>;

export type CacheOptions = Readonly<{
  maxEntries: number;
  ttlMs: number;
  now?: () => number;
}>;

/** A small LRU cache with per-entry expiry; reads refresh recency. */
export class ExpiringCache<Value> {
  private readonly entries = new Map<string, CacheEntry<Value>>();
  private readonly now: () => number;

  constructor(private readonly options: CacheOptions) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive integer");
    }
    this.now = options.now ?? Date.now;
  }

  get(key: string): Value | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: Value): void {
    this.entries.delete(key);
    this.entries.set(key, { expiresAt: this.now() + this.options.ttlMs, key, value });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

export function stableCacheKey(parts: readonly (string | number | boolean | null)[]): string {
  const canonical = JSON.stringify(parts.map((part) => (typeof part === "string" ? part.normalize("NFC") : part)));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export async function withCachedResult<Value>(
  cache: ExpiringCache<Promise<Value>>,
  key: string,
  load: (signal: AbortSignal) => Promise<Value>,
  signal: AbortSignal
): Promise<Value> {
  const pending = cache.get(key);
  if (pending) return pending;
  const next = load(signal);
  cache.set(key, next);
  return next;
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 300_000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, Math.min(date - now, 300_000));
}
`;

const TRACKER_TITLES = [
  "Billing export skips invoices created after midnight UTC",
  "Retry budget exhausted for webhook deliveries to partner endpoints",
  "Dashboard tile shows stale revenue totals after failover",
  "Rotate signing keys for the internal audit service",
  "Reduce cold-start latency of the report renderer",
  "Search index rebuild stalls on archived projects",
  "Add pagination to the customer usage API",
  "Alert on queue depth above ten thousand messages"
] as const;

/** An MCP tools/call result: JSON text content plus the same structured payload. */
function mcpToolResult(): string {
  const statuses = ["open", "in_progress", "blocked", "resolved"] as const;
  const records = Array.from({ length: 10 }, (_, index) => ({
    id: `${(0x5f3a9c2e + index * 0x1f2d3).toString(16)}-${(0x4b1d + index * 17).toString(16)}-4e${(index * 7).toString(16).padStart(2, "0")}-9a1c-${(0x2c4e6f8a0b1d + index * 0x3b5d).toString(16)}`,
    key: `OPS-${1400 + index * 7}`,
    title: TRACKER_TITLES[index % TRACKER_TITLES.length],
    status: statuses[index % statuses.length],
    priority: `P${(index % 3) + 1}`,
    assignee: { id: `user-${17 + index}`, team: index % 2 === 0 ? "platform" : "billing" },
    labels: index % 2 === 0 ? ["backend", "reliability"] : ["api", "customer-facing"],
    createdAt: `2026-0${(index % 8) + 1}-${String(10 + index).padStart(2, "0")}T0${index % 10}:15:00Z`,
    updatedAt: `2026-09-${String(10 + index).padStart(2, "0")}T1${index % 10}:42:31Z`,
    estimateHours: Math.round((index * 1.75 + 2.5) * 100) / 100,
    commentCount: (index * 3) % 11,
    url: `https://tracker.example.com/browse/OPS-${1400 + index * 7}`
  }));
  const payload = { total: 57, nextCursor: "c2VxOjEwfHNvcnQ6dXBkYXRlZA", records };
  return JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false
  });
}

/** Base64 of deterministic pseudo-random bytes (xorshift32), like an inline image. */
function base64Payload(bytes: number): string {
  let state = 0x9e3779b9;
  let binary = "";
  for (let index = 0; index < bytes; index += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    binary += String.fromCharCode(state & 0xff);
  }
  return btoa(binary);
}

export const TOKEN_ESTIMATE_FIXTURES: readonly TokenEstimateFixture[] = Object.freeze([
  { contentClass: "latin_prose", name: "english_prose", text: ENGLISH_PROSE },
  { contentClass: "cyrillic_prose", name: "russian_prose", text: RUSSIAN_PROSE },
  {
    contentClass: "cyrillic_prose",
    name: "russian_technical",
    text: "Ошибка воспроизводится при запуске миграции: колонка получает значение v1, но старые записи без policy остаются на legacy-пути; проверьте логи контейнера app-1 за 26.09.2026 14:35 UTC. ".repeat(20)
  },
  { contentClass: "code", name: "typescript_code", text: TYPESCRIPT_CODE },
  { contentClass: "json", name: "mcp_json", text: mcpToolResult() },
  { contentClass: "base64", name: "base64", text: base64Payload(2_400) },
  {
    contentClass: "other_script",
    name: "greek_prose",
    text: "Ο χρήστης ζητά μια αναφορά πωλήσεων για το τρίτο τρίμηνο, λαμβάνοντας υπόψη τις επιστροφές. ".repeat(20)
  },
  {
    contentClass: "other_script",
    name: "hebrew_prose",
    text: "המשתמש מבקש להכין דוח מכירות לרבעון השלישי, לקחת בחשבון החזרות ולא לכלול הזמנות בדיקה. ".repeat(20)
  },
  {
    contentClass: "other_script",
    name: "arabic_prose",
    text: "يطلب المستخدم إعداد تقرير عن مبيعات الربع الثالث مع مراعاة المرتجعات واستبعاد الطلبات التجريبية. ".repeat(20)
  },
  {
    contentClass: "cjk",
    name: "japanese_prose",
    text: "ユーザーは第3四半期の売上レポートの作成を依頼し、返品を考慮し、テスト注文を除外するよう求めています。".repeat(20)
  },
  {
    contentClass: "cjk",
    name: "chinese_prose",
    text: "用户要求准备第三季度的销售报告，考虑退货并排除测试订单。经理明确了期限、预算和负责人。".repeat(20)
  }
]);
