import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  MEMORY_UI_LOCALES,
  type MemoryUiLocale
} from "./memory";

export { MEMORY_CONFIRMATION_COPY_VERSION };

export const MEMORY_COPY_KEYS = [
  "settings.useFacts.label",
  "settings.referenceHistory.label",
  "settings.learnAutomatically.label",
  "settings.savedWhileUseOff",
  "settings.manage.label",
  "archive.action",
  "archive.explanation",
  "restore.action",
  "exclude.action",
  "exclude.explanation",
  "resume.action",
  "resume.explanation",
  "forget.action",
  "forget.explanation",
  "permanentDelete.action",
  "permanentDelete.explanation",
  "temporary.label",
  "temporary.explanation",
  "temporary.retention",
  "temporary.externalRetention",
  "consent.title",
  "consent.explanation",
  "consent.reviewRequired",
  "consent.answerDestination",
  "consent.systemDestination",
  "consent.embeddingDestination",
  "consent.rerankerDestination",
  "bulkDelete.explicit.action",
  "bulkDelete.learned.action",
  "bulkDelete.history.action",
  "bulkDelete.reusable.action",
  "bulkDelete.reusable.explanation",
  "receipt.title",
  "receipt.laterForgotten",
  "receipt.sourceDeleted",
  "deletion.blockedAdmin"
] as const;

export type MemoryCopyKey = (typeof MEMORY_COPY_KEYS)[number];
export type MemoryCopyCatalog = Readonly<Record<MemoryUiLocale, Readonly<Record<MemoryCopyKey, string>>>>;

export const MEMORY_COPY: MemoryCopyCatalog = Object.freeze({
  EN: Object.freeze({
    "archive.action": "Archive",
    "archive.explanation": "Moves this chat out of the active list. The retained chat remains eligible as a Memory source.",
    "bulkDelete.explicit.action": "Delete all saved memories",
    "bulkDelete.history.action": "Clear chat-history memory index",
    "bulkDelete.learned.action": "Delete automatically learned memories",
    "bulkDelete.reusable.action": "Delete all reusable memory data",
    "bulkDelete.reusable.explanation": "Deletes reusable facts, history index, and profile data. It does not delete retained chats, rewrite old accepted runs, erase provider-retained requests, or rewrite operator backups.",
    "consent.answerDestination": "Selected answer model: final bounded snippets may be sent with the accepted run.",
    "consent.embeddingDestination": "Embedding destination: eligible bounded text may be sent only to the disclosed configured deployment.",
    "consent.explanation": "Review the exact current Memory destinations. A material destination change pauses affected external Memory work until you accept it.",
    "consent.rerankerDestination": "Remote reranker: bounded eligible candidates may be sent only when this destination is configured and accepted.",
    "consent.reviewRequired": "Review required before external Memory processing can continue.",
    "consent.systemDestination": "System Memory model: bounded eligible source text may be sent for qualified extraction or verification.",
    "consent.title": "Review Memory data destinations",
    "deletion.blockedAdmin": "Future Memory use is fenced, but physical deletion needs administrator attention and will keep retrying.",
    "exclude.action": "Exclude this chat from memory",
    "exclude.explanation": "Keeps the chat but immediately stops using it as a source for automatic recall and learning. Archive status does not change.",
    "forget.action": "Forget",
    "forget.explanation": "Stops future Memory use and suppresses relearning from the same unchanged evidence. Retained chat text and old accepted runs are not rewritten.",
    "permanentDelete.action": "Delete permanently",
    "permanentDelete.explanation": "Deletes this chat and its owned run data, revokes its shares, and reconciles Memory derivatives. Provider retention and operator backups are not rewritten.",
    "receipt.laterForgotten": "Later forgotten",
    "receipt.sourceDeleted": "Source deleted",
    "receipt.title": "Memory",
    "restore.action": "Restore",
    "resume.action": "Resume using this chat as a memory source",
    "resume.explanation": "Allows a controlled active-branch reindex. Prior Forget and bulk-clear barriers remain in force, and external work still requires accepted destinations.",
    "settings.learnAutomatically.label": "Learn useful memories automatically",
    "settings.manage.label": "Manage Memories",
    "settings.referenceHistory.label": "Reference chat history",
    "settings.savedWhileUseOff": "Saved; memory use is off.",
    "settings.useFacts.label": "Use memory facts",
    "temporary.explanation": "Temporary Chat reads and writes no personal Memory, cannot be converted to a retained chat, and cannot be shared.",
    "temporary.externalRetention": "External providers and tools may retain data under their disclosed policies; operator backups are a separate domain.",
    "temporary.label": "Temporary Chat",
    "temporary.retention": "The complete chat aggregate is scheduled for durable deletion 24 hours after the last terminal run, or after creation or last local activity if no run settles."
  }),
  RU: Object.freeze({
    "archive.action": "Архивировать",
    "archive.explanation": "Убирает чат из активного списка. Сохранённый чат остаётся допустимым источником для Памяти.",
    "bulkDelete.explicit.action": "Удалить все сохранённые воспоминания",
    "bulkDelete.history.action": "Очистить индекс памяти истории чатов",
    "bulkDelete.learned.action": "Удалить автоматически выученные воспоминания",
    "bulkDelete.reusable.action": "Удалить все повторно используемые данные Памяти",
    "bulkDelete.reusable.explanation": "Удаляет повторно используемые факты, индекс истории и профиль. Сохранённые чаты не удаляются, старые принятые запуски не переписываются, уже сохранённые провайдером запросы и резервные копии оператора не стираются.",
    "consent.answerDestination": "Выбранная модель ответа: финальные ограниченные фрагменты могут быть отправлены вместе с принятым запуском.",
    "consent.embeddingDestination": "Назначение эмбеддингов: допустимый ограниченный текст отправляется только в раскрытое настроенное развёртывание.",
    "consent.explanation": "Проверьте точные текущие назначения Памяти. Существенное изменение назначения приостанавливает затронутую внешнюю обработку Памяти до вашего согласия.",
    "consent.rerankerDestination": "Удалённый реранкер: ограниченные допустимые кандидаты отправляются только при настроенном и принятом назначении.",
    "consent.reviewRequired": "Перед продолжением внешней обработки Памяти требуется проверка.",
    "consent.systemDestination": "Системная модель Памяти: ограниченный допустимый исходный текст может отправляться для квалифицированного извлечения или проверки.",
    "consent.title": "Проверьте назначения данных Памяти",
    "deletion.blockedAdmin": "Будущее использование Памяти уже заблокировано, но физическое удаление требует внимания администратора и продолжит повторные попытки.",
    "exclude.action": "Исключить этот чат из памяти",
    "exclude.explanation": "Сохраняет чат, но немедленно прекращает использовать его как источник автоматического поиска и обучения. Состояние архива не меняется.",
    "forget.action": "Забыть",
    "forget.explanation": "Прекращает будущее использование Памятью и подавляет повторное обучение по тем же неизменённым данным. Сохранённый текст чата и старые принятые запуски не переписываются.",
    "permanentDelete.action": "Удалить навсегда",
    "permanentDelete.explanation": "Удаляет чат и принадлежащие ему данные запусков, отзывает его публикации и согласует производные Памяти. Сроки хранения провайдера и резервные копии оператора не переписываются.",
    "receipt.laterForgotten": "Позже забыто",
    "receipt.sourceDeleted": "Источник удалён",
    "receipt.title": "Память",
    "restore.action": "Восстановить",
    "resume.action": "Снова использовать этот чат как источник памяти",
    "resume.explanation": "Разрешает контролируемую переиндексацию активной ветки. Предыдущие барьеры забывания и массовой очистки сохраняются, а внешняя обработка по-прежнему требует принятых назначений.",
    "settings.learnAutomatically.label": "Автоматически запоминать полезные факты",
    "settings.manage.label": "Управление памятью",
    "settings.referenceHistory.label": "Ссылаться на историю чатов",
    "settings.savedWhileUseOff": "Сохранено; использование памяти выключено.",
    "settings.useFacts.label": "Использовать факты из памяти",
    "temporary.explanation": "Временный чат не читает и не записывает личную Память, не может быть преобразован в сохраняемый чат и не может быть опубликован.",
    "temporary.externalRetention": "Внешние провайдеры и инструменты могут хранить данные по раскрытым правилам; резервные копии оператора относятся к отдельной области.",
    "temporary.label": "Временный чат",
    "temporary.retention": "Полный агрегат чата ставится на гарантированное удаление через 24 часа после последнего завершённого запуска либо после создания или последней локальной активности, если ни один запуск не завершился."
  })
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function memoryCopyCatalogIsComplete(value: unknown): value is MemoryCopyCatalog {
  if (!isRecord(value)) return false;
  if (Object.keys(value).length !== MEMORY_UI_LOCALES.length) return false;
  return MEMORY_UI_LOCALES.every((locale) => {
    const entries = value[locale];
    if (!isRecord(entries) || Object.keys(entries).length !== MEMORY_COPY_KEYS.length) return false;
    return MEMORY_COPY_KEYS.every((key) => {
      const copy = entries[key];
      return typeof copy === "string" && copy.trim().length > 0 && !copy.includes("\u0000");
    });
  });
}

export class MemoryCopyContractError extends Error {
  readonly code = "memory_copy_missing";

  constructor(locale: string, key: string) {
    super(`Memory copy is missing for ${locale}:${key}`);
    this.name = "MemoryCopyContractError";
  }
}

export function resolveMemoryCopy(
  locale: MemoryUiLocale,
  key: MemoryCopyKey,
  catalog: unknown = MEMORY_COPY
): string {
  if (!memoryCopyCatalogIsComplete(catalog)) {
    throw new MemoryCopyContractError(locale, key);
  }
  const value = catalog[locale][key];
  if (!value) throw new MemoryCopyContractError(locale, key);
  return value;
}
