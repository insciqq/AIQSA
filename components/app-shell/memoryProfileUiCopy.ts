import type { MemoryUiLocale } from "@/lib/contracts/memory";

const COPY = {
  EN: {
    advanced: "Advanced view",
    advancedDescription: "See where each memory came from, how AIQSA currently uses it, and its change history.",
    automatic: "Learned from chats",
    cold: "Background",
    delete: "Delete",
    deleting: "Deleting…",
    description: "A short memory summary used to personalize future answers.",
    disabled: "Memory is off. Your saved memories are still available below.",
    edit: "Edit",
    empty: "No summary yet. Add a memory or keep using AIQSA to build one.",
    error: "The summary could not be loaded. Your memories are still available below.",
    explicit: "Saved by you",
    hot: "Often useful",
    loading: "Loading your memory summary…",
    mutationError: "That memory could not be changed. Refresh the summary and try again.",
    pending: "Updating your memory summary…",
    pinned: "Pinned",
    priority: "Use priority",
    redacted: "Sensitive or unsupported details were left out of this summary.",
    retry: "Try again",
    source: "Source",
    sourceAndHistory: "Sources and history",
    title: "What AIQSA remembers about you",
    unavailable: "The summary is not available right now. Your individual memories are still available below.",
    updated: "Updated",
    waiting: "The summary will appear when the configured memory model is available.",
    warm: "Contextual"
  },
  RU: {
    advanced: "Расширенный режим",
    advancedDescription: "Показывает, откуда взялось каждое воспоминание, как AIQSA сейчас его использует и как оно менялось.",
    automatic: "Изучено из чатов",
    cold: "Фоновое",
    delete: "Удалить",
    deleting: "Удаляем…",
    description: "Краткая сводка памяти для персонализации будущих ответов.",
    disabled: "Память выключена. Сохранённые воспоминания по-прежнему доступны ниже.",
    edit: "Изменить",
    empty: "Сводки пока нет. Добавьте воспоминание или продолжайте пользоваться AIQSA.",
    error: "Не удалось загрузить сводку. Отдельные воспоминания по-прежнему доступны ниже.",
    explicit: "Сохранено вами",
    hot: "Часто полезно",
    loading: "Загружаем сводку памяти…",
    mutationError: "Не удалось изменить это воспоминание. Обновите сводку и попробуйте снова.",
    pending: "Обновляем сводку памяти…",
    pinned: "Закреплено",
    priority: "Приоритет использования",
    redacted: "Чувствительные или неподдерживаемые сведения не включены в эту сводку.",
    retry: "Повторить",
    source: "Источник",
    sourceAndHistory: "Источники и история",
    title: "Что AIQSA помнит о вас",
    unavailable: "Сводка сейчас недоступна. Отдельные воспоминания по-прежнему доступны ниже.",
    updated: "Обновлено",
    waiting: "Сводка появится, когда настроенная модель памяти станет доступна.",
    warm: "Контекстное"
  }
} as const;

type MemoryProfileCopyKey = keyof typeof COPY.EN;

export function memoryProfileUiCopy(
  locale: MemoryUiLocale,
  key: MemoryProfileCopyKey
): string {
  return COPY[locale][key];
}
