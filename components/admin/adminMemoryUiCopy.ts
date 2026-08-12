import type { AdminMemoryDestinationId } from "@/lib/contracts/adminMemory";
import type { AdminMemoryHealth } from "@/lib/contracts/memoryHealth";

export type AdminMemoryLocale = "EN" | "RU";

type Copy = Readonly<{
  active: string;
  acknowledge: string;
  acknowledging: string;
  acknowledgedFingerprint: string;
  advanced: string;
  advancedDescription: string;
  currentFingerprint: string;
  currentPolicy: string;
  deletion: string;
  blocked: string;
  destinationMatrix: string;
  destinationMissing: string;
  fingerprintNever: string;
  heading: string;
  installationPolicy: string;
  intro: string;
  lastAcknowledgment: string;
  loading: string;
  notice: string;
  operationalEvidence: string;
  oldest: string;
  outcomeUnknown: string;
  perUser: string;
  policyRevision: string;
  provider: string;
  queue: string;
  refresh: string;
  recentFailures: string;
  reviewDescription: string;
  reviewTitle: string;
  scheduler: string;
  safetyBlocked: string;
  safetyTemporary: string;
  trustDescription: string;
  usageIncomplete: string;
  destinationReview: string;
  failed: string;
  waitingJobs: string;
}>;

const COPY: Readonly<Record<AdminMemoryLocale, Copy>> = {
  EN: {
    active: "Active",
    acknowledge: "Acknowledge current destinations",
    acknowledging: "Acknowledging…",
    acknowledgedFingerprint: "Acknowledged fingerprint",
    advanced: "Advanced",
    advancedDescription: "Bounded queue evidence, destination bindings, fingerprints, and policy revisions.",
    currentFingerprint: "Current fingerprint",
    currentPolicy: "Policy",
    deletion: "Cleanup",
    blocked: "Blocked",
    destinationMatrix: "Memory destination matrix",
    destinationMissing: "No current destination",
    fingerprintNever: "Not acknowledged",
    heading: "Memory health",
    installationPolicy: "Installation Memory",
    intro: "See whether personalization is working and act only when the installation needs attention.",
    lastAcknowledgment: "Last acknowledgment",
    loading: "Loading Memory health…",
    notice: "Current Memory destinations acknowledged. Waiting work will resume automatically.",
    operationalEvidence: "Operational evidence",
    oldest: "Oldest wait",
    outcomeUnknown: "Outcome unknown",
    perUser: "This installation uses per-user destination review. No administrator acknowledgment is available here.",
    policyRevision: "Policy revision",
    provider: "Provider work",
    queue: "Background queue",
    refresh: "Refresh",
    recentFailures: "Recent failures",
    reviewDescription: "New or changed destinations keep only affected external Memory work waiting.",
    reviewTitle: "Destination review required",
    scheduler: "Background allowance",
    safetyBlocked: "A durable Memory cleanup has exhausted fast retries. Retrieval remains fenced and slow reconciliation continues.",
    safetyTemporary: "At least one Temporary chat is past its retention deadline and remains hidden while cleanup continues.",
    trustDescription: "Destination acknowledgment is an installation trust decision. Per-call evidence remains inspectable without exposing personal Memory content here.",
    usageIncomplete: "Usage incomplete",
    destinationReview: "Destination review",
    failed: "Failed",
    waitingJobs: "Waiting external jobs"
  },
  RU: {
    active: "Активно",
    acknowledge: "Подтвердить текущие назначения",
    acknowledging: "Подтверждаем…",
    acknowledgedFingerprint: "Подтверждённый отпечаток",
    advanced: "Расширенный режим",
    advancedDescription: "Ограниченные сведения об очереди, привязки назначений, отпечатки и редакции политики.",
    currentFingerprint: "Текущий отпечаток",
    currentPolicy: "Политика",
    deletion: "Очистка",
    blocked: "Заблокировано",
    destinationMatrix: "Матрица назначений Памяти",
    destinationMissing: "Текущее назначение отсутствует",
    fingerprintNever: "Не подтверждено",
    heading: "Состояние Памяти",
    installationPolicy: "Память установки",
    intro: "Проверьте, работает ли персонализация, и действуйте только тогда, когда установке требуется внимание.",
    lastAcknowledgment: "Последнее подтверждение",
    loading: "Загружаем состояние Памяти…",
    notice: "Текущие назначения Памяти подтверждены. Ожидающая работа возобновится автоматически.",
    operationalEvidence: "Операционные сведения",
    oldest: "Самое долгое ожидание",
    outcomeUnknown: "Исход неизвестен",
    perUser: "В этой установке назначения проверяет каждый пользователь. Подтверждение администратором здесь недоступно.",
    policyRevision: "Редакция политики",
    provider: "Работа провайдеров",
    queue: "Фоновая очередь",
    refresh: "Обновить",
    recentFailures: "Недавние ошибки",
    reviewDescription: "Новые или изменённые назначения приостанавливают только затронутую внешнюю работу Памяти.",
    reviewTitle: "Нужно проверить назначения",
    scheduler: "Лимит фоновой работы",
    safetyBlocked: "Надёжная очистка Памяти исчерпала быстрые попытки. Извлечение остаётся ограждено, а медленная сверка продолжается.",
    safetyTemporary: "Как минимум один временный чат превысил срок хранения и остаётся скрытым, пока продолжается очистка.",
    trustDescription: "Подтверждение назначения — решение о доверии на уровне установки. Сведения каждого вызова остаются проверяемыми, но личное содержимое Памяти здесь не показывается.",
    usageIncomplete: "Учёт использования неполный",
    destinationReview: "Проверка назначений",
    failed: "Ошибки",
    waitingJobs: "Ожидающие внешние задачи"
  }
};

export function adminMemoryCopy(locale: AdminMemoryLocale): Copy {
  void locale;
  return COPY.EN;
}

export function adminMemoryOverallCopy(
  locale: AdminMemoryLocale,
  overall: AdminMemoryHealth["overall"]
): Readonly<{ description: string; title: string }> {
  const copy = {
    EN: {
      ACTION_REQUIRED: {
        description: "A safety or trust obligation needs administrator attention. Core chat remains available.",
        title: "Memory needs attention"
      },
      DEGRADED: {
        description: "Personalization remains available, but some background work is delayed or degraded.",
        title: "Memory is running with delays"
      },
      HEALTHY: {
        description: "Queues, provider work, and durable cleanup are within their normal operating state.",
        title: "Memory is healthy"
      },
      UNAVAILABLE: {
        description: "Destination settings remain available, but aggregate operational health could not be checked. Refresh to try again.",
        title: "Memory health is unavailable"
      }
    },
    RU: {
      ACTION_REQUIRED: {
        description: "Обязательство по безопасности или доверию требует внимания администратора. Основной чат продолжает работать.",
        title: "Памяти требуется внимание"
      },
      DEGRADED: {
        description: "Персонализация доступна, но часть фоновой работы отложена или выполняется в ограниченном режиме.",
        title: "Память работает с задержками"
      },
      HEALTHY: {
        description: "Очереди, работа провайдеров и надёжная очистка находятся в нормальном состоянии.",
        title: "Память работает нормально"
      },
      UNAVAILABLE: {
        description: "Настройки назначений доступны, но агрегированное операционное состояние проверить не удалось. Обновите данные и повторите попытку.",
        title: "Состояние Памяти недоступно"
      }
    }
  } as const;
  void locale;
  return copy.EN[overall];
}

export function adminMemoryStateCopy(
  locale: AdminMemoryLocale,
  domain: "deletion" | "provider" | "queue" | "scheduler",
  state: string
): string {
  const values: Readonly<Record<AdminMemoryLocale, Readonly<Record<string, string>>>> = {
    EN: {
      ATTENTION_REQUIRED: "Administrator attention required",
      BLOCKED: "Recent failures need review",
      CLEAR: "No waiting work",
      DEGRADED: "Recent provider work is incomplete",
      DEFERRED: "Daily background allowance reached",
      DELAYED: "Some work is delayed",
      HEALTHY: "Ready",
      IDLE: "No recent provider work",
      READY: "Ready",
      UNAVAILABLE: "Status unavailable",
      UNKNOWN: "Unknown",
      WORKING: domain === "deletion" ? "Cleanup in progress" : "Processing normally"
    },
    RU: {
      ATTENTION_REQUIRED: "Нужно внимание администратора",
      BLOCKED: "Недавние ошибки требуют проверки",
      CLEAR: "Ожидающей работы нет",
      DEGRADED: "Недавняя работа провайдера завершена не полностью",
      DEFERRED: "Дневной лимит фоновой работы исчерпан",
      DELAYED: "Часть работы отложена",
      HEALTHY: "Готово",
      IDLE: "Недавних вызовов провайдера нет",
      READY: "Готово",
      UNAVAILABLE: "Состояние недоступно",
      UNKNOWN: "Неизвестно",
      WORKING: domain === "deletion" ? "Очистка выполняется" : "Обработка идёт нормально"
    }
  };
  void locale;
  return values.EN[state] ?? state;
}

export function adminMemoryCountCopy(
  locale: AdminMemoryLocale,
  band: AdminMemoryHealth["queue"]["active"]
): string {
  void locale;
  return ({
    EN: { MANY: "Many", NONE: "None", SOME: "Some", UNKNOWN: "Unknown" },
    RU: { MANY: "Много", NONE: "Нет", SOME: "Есть", UNKNOWN: "Неизвестно" }
  } as const).EN[band];
}

export function adminMemoryLagCopy(
  locale: AdminMemoryLocale,
  lag: AdminMemoryHealth["queue"]["oldestLag"]
): string {
  void locale;
  return ({
    EN: {
      NONE: "No active queue",
      OVER_24_HOURS: "Over 24 hours",
      UNDER_15_MINUTES: "Under 15 minutes",
      UNDER_1_HOUR: "Under 1 hour",
      UNDER_24_HOURS: "Under 24 hours",
      UNDER_5_MINUTES: "Under 5 minutes",
      UNKNOWN: "Unknown"
    },
    RU: {
      NONE: "Активной очереди нет",
      OVER_24_HOURS: "Более 24 часов",
      UNDER_15_MINUTES: "Менее 15 минут",
      UNDER_1_HOUR: "Менее часа",
      UNDER_24_HOURS: "Менее 24 часов",
      UNDER_5_MINUTES: "Менее 5 минут",
      UNKNOWN: "Неизвестно"
    }
  } as const).EN[lag];
}

export function adminMemoryDestinationCopy(
  locale: AdminMemoryLocale,
  id: AdminMemoryDestinationId
): Readonly<{ description: string; label: string }> {
  void locale;
  const rows = {
    EN: {
      answer_provider: {
        description: "Selected snippets travel only with an accepted answer request; each run pins its exact binding.",
        label: "Selected answer model"
      },
      embedding: {
        description: "Eligible bounded text may use these embedding deployments.",
        label: "Embedding deployment"
      },
      remote_reranker: {
        description: "Bounded candidates use this destination only when remote reranking is active.",
        label: "Remote reranker"
      },
      system_model: {
        description: "Background extraction, verification, profiles, and query expansion use this role.",
        label: "System Memory model"
      }
    },
    RU: {
      answer_provider: {
        description: "Выбранные фрагменты отправляются только с принятым запросом ответа; каждый запуск фиксирует точную привязку.",
        label: "Выбранная модель ответа"
      },
      embedding: {
        description: "Допустимый ограниченный текст может использовать эти развёртывания эмбеддингов.",
        label: "Развёртывание эмбеддингов"
      },
      remote_reranker: {
        description: "Ограниченные кандидаты используют это назначение только при включённом удалённом реранжировании.",
        label: "Удалённый реранкер"
      },
      system_model: {
        description: "Фоновое извлечение, проверка, профили и расширение запросов используют эту роль.",
        label: "Системная модель Памяти"
      }
    }
  } as const;
  return rows.EN[id];
}

export function adminMemoryDestinationStateCopy(
  locale: AdminMemoryLocale,
  state: "AVAILABLE" | "BOUND_PER_RUN" | "REVIEW_REQUIRED" | "UNAVAILABLE"
): string {
  void locale;
  return ({
    EN: {
      AVAILABLE: "Available",
      BOUND_PER_RUN: "Bound per run",
      REVIEW_REQUIRED: "Review required",
      UNAVAILABLE: "Not configured"
    },
    RU: {
      AVAILABLE: "Доступно",
      BOUND_PER_RUN: "Привязка на запуск",
      REVIEW_REQUIRED: "Нужна проверка",
      UNAVAILABLE: "Не настроено"
    }
  } as const).EN[state];
}
