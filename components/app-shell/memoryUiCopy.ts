import type {
  MemoryFactState,
  MemoryModality,
  MemoryReceipt,
  MemoryReceiptItem,
  MemoryReceiptItemType,
  MemoryReceiptLifecycleState,
  MemoryScopeType,
  MemorySensitivityClass,
  MemoryUiLocale
} from "@/lib/contracts/memory";

export const MEMORY_UI_COPY_KEYS = [
  "settings.heading",
  "settings.intro",
  "settings.loading",
  "settings.loadError",
  "settings.retry",
  "settings.localeHeading",
  "settings.localeDescription",
  "settings.localeRu",
  "settings.localeEn",
  "settings.policyHeading",
  "settings.policyDescription",
  "settings.useFactsDescription",
  "settings.referenceHistoryDescription",
  "settings.learnAutomaticallyDescription",
  "settings.capabilityReady",
  "settings.capabilityUnavailable",
  "settings.capabilitiesHeading",
  "settings.capabilityExplicit",
  "settings.capabilityHistory",
  "settings.capabilityLearning",
  "settings.capabilityRussian",
  "settings.destinationsHeading",
  "settings.destinationsDescription",
  "settings.answerDestination",
  "settings.systemDestination",
  "settings.embeddingDestination",
  "settings.rerankerDestination",
  "settings.selectedAtRun",
  "settings.destinationUnavailable",
  "settings.currentFingerprint",
  "settings.acceptedFingerprint",
  "settings.policyVersion",
  "settings.acceptedAt",
  "settings.notAccepted",
  "settings.reviewAction",
  "settings.acceptAction",
  "settings.cancelReview",
  "settings.reviewComplete",
  "settings.saved",
  "settings.stale",
  "settings.saveError",
  "settings.manageDescription",
  "settings.manageUnavailable",
  "manager.title",
  "manager.back",
  "manager.new",
  "manager.searchLabel",
  "manager.searchPlaceholder",
  "manager.searchAction",
  "manager.clearSearch",
  "manager.loading",
  "manager.loadError",
  "manager.retry",
  "manager.empty",
  "manager.noResults",
  "manager.loadMore",
  "manager.loadingMore",
  "manager.selectPrompt",
  "manager.pinned",
  "manager.explicit",
  "manager.global",
  "manager.sources",
  "manager.sourceCount",
  "manager.updated",
  "manager.detail",
  "manager.backToList",
  "manager.edit",
  "manager.pin",
  "manager.unpin",
  "manager.forget",
  "manager.authority",
  "manager.scope",
  "manager.state",
  "manager.index",
  "manager.category",
  "manager.modality",
  "manager.sensitivity",
  "manager.created",
  "manager.lastConfirmed",
  "manager.lastUsed",
  "manager.validity",
  "manager.currentVersion",
  "manager.never",
  "manager.notSet",
  "manager.evidenceHeading",
  "manager.evidenceDescription",
  "manager.evidenceLoading",
  "manager.evidenceError",
  "manager.evidenceEmpty",
  "manager.evidenceMore",
  "manager.supports",
  "manager.contradicts",
  "manager.evidenceMessage",
  "manager.evidenceAction",
  "manager.observed",
  "manager.createTitle",
  "manager.editTitle",
  "manager.statement",
  "manager.statementHelp",
  "manager.categoryHelp",
  "manager.modalityHelp",
  "manager.saveNew",
  "manager.saveChanges",
  "manager.cancel",
  "manager.saving",
  "manager.saved",
  "manager.draftStale",
  "manager.validationStatement",
  "manager.validationCategory",
  "manager.mutationError",
  "manager.secretRejected",
  "manager.forgetTitle",
  "manager.forgetDescription",
  "manager.forgetConfirm",
  "manager.forgetting",
  "manager.forgotten",
  "manager.deleteHeading",
  "manager.deleteDescription",
  "manager.deleteTitle",
  "manager.deleteExplanation",
  "manager.deleteRetention",
  "manager.deleteConfirmation",
  "manager.deleteWorking",
  "manager.deleteProgress",
  "manager.deletePending",
  "manager.deleteRunning",
  "manager.deleteRetry",
  "manager.deleteSucceeded",
  "manager.deleteCheckAgain",
  "manager.deleteStatusId",
  "manager.lastAudit",
  "manager.deleteStale",
  "manager.savedUseOff",
  "manager.closeDraftWarning",
  "manager.discardTitle",
  "manager.discardBody",
  "manager.keepEditing",
  "manager.discardDraft",
  "receipt.label",
  "receipt.usedOne",
  "receipt.usedMany",
  "receipt.degraded",
  "receipt.outcome",
  "receipt.exactText",
  "receipt.type",
  "receipt.source",
  "receipt.sourceUnavailable",
  "receipt.scope",
  "receipt.version",
  "receipt.selection",
  "action.saved",
  "action.updated",
  "action.forgotten",
  "action.ambiguous",
  "action.manage",
  "common.on",
  "common.off",
  "common.available",
  "common.unavailable"
] as const;

export type MemoryUiCopyKey = (typeof MEMORY_UI_COPY_KEYS)[number];
type MemoryUiCopyLocale = Readonly<Record<MemoryUiCopyKey, string>>;

const EN = {
  "settings.heading": "Memory",
  "settings.intro": "Choose what AIQSA may remember and inspect the exact saved facts under your account.",
  "settings.loading": "Loading Memory settings…",
  "settings.loadError": "Memory settings could not be loaded.",
  "settings.retry": "Retry",
  "settings.localeHeading": "Memory language",
  "settings.localeDescription": "This account preference controls all Memory controls, confirmations, and status messages.",
  "settings.localeRu": "Русский",
  "settings.localeEn": "English",
  "settings.policyHeading": "Remembering policy",
  "settings.policyDescription": "These three choices are independent. Turning one off retains existing data.",
  "settings.useFactsDescription": "Allow eligible saved and learned facts to be included in future answers.",
  "settings.referenceHistoryDescription": "Allow eligible retained chat history to be searched as Memory when this capability is available.",
  "settings.learnAutomaticallyDescription": "Allow qualified automatic learning from retained chats when this capability is available.",
  "settings.capabilityReady": "Available now",
  "settings.capabilityUnavailable": "Preference is stored; this capability is not active in the current installation.",
  "settings.capabilitiesHeading": "Current capabilities",
  "settings.capabilityExplicit": "Explicit saved memories",
  "settings.capabilityHistory": "Chat-history recall",
  "settings.capabilityLearning": "Automatic learning",
  "settings.capabilityRussian": "Russian qualification",
  "settings.destinationsHeading": "Memory data destinations",
  "settings.destinationsDescription": "Review the current destinations before any affected external Memory processing continues.",
  "settings.answerDestination": "Selected answer model",
  "settings.systemDestination": "System Memory model",
  "settings.embeddingDestination": "Embedding deployment",
  "settings.rerankerDestination": "Remote reranker",
  "settings.selectedAtRun": "Selected and recorded for each accepted run",
  "settings.destinationUnavailable": "Not configured or unavailable",
  "settings.currentFingerprint": "Current destination fingerprint",
  "settings.acceptedFingerprint": "Accepted destination fingerprint",
  "settings.policyVersion": "Policy version",
  "settings.acceptedAt": "Accepted",
  "settings.notAccepted": "Not accepted",
  "settings.reviewAction": "Review destinations",
  "settings.acceptAction": "Accept current destinations",
  "settings.cancelReview": "Close review",
  "settings.reviewComplete": "Current Memory destinations accepted.",
  "settings.saved": "Memory setting saved.",
  "settings.stale": "Memory settings changed elsewhere. The current server state has been reloaded.",
  "settings.saveError": "Memory setting could not be saved.",
  "settings.manageDescription": "Review, add, correct, pin, or forget exact saved facts. This remains separate from automatic learning and chat-history recall.",
  "settings.manageUnavailable": "Explicit Memory management is not active in the current installation.",
  "manager.title": "Manage Memories",
  "manager.back": "Back to Memory settings",
  "manager.new": "New memory",
  "manager.searchLabel": "Search saved memories",
  "manager.searchPlaceholder": "Search exact saved facts",
  "manager.searchAction": "Search",
  "manager.clearSearch": "Clear search",
  "manager.loading": "Loading saved memories…",
  "manager.loadError": "Saved memories could not be loaded.",
  "manager.retry": "Retry",
  "manager.empty": "No saved memories yet.",
  "manager.noResults": "No saved memories match this search.",
  "manager.loadMore": "Load more",
  "manager.loadingMore": "Loading more…",
  "manager.selectPrompt": "Select a saved memory to inspect its exact statement and evidence.",
  "manager.pinned": "Pinned",
  "manager.explicit": "Explicit user save",
  "manager.global": "Your account",
  "manager.sources": "sources",
  "manager.sourceCount": "Source count",
  "manager.updated": "Updated",
  "manager.detail": "Memory detail",
  "manager.backToList": "Back to saved memories",
  "manager.edit": "Edit",
  "manager.pin": "Pin",
  "manager.unpin": "Unpin",
  "manager.forget": "Forget",
  "manager.authority": "Authority",
  "manager.scope": "Scope",
  "manager.state": "State",
  "manager.index": "Search index",
  "manager.category": "Category",
  "manager.modality": "Kind",
  "manager.sensitivity": "Sensitivity",
  "manager.created": "Created",
  "manager.lastConfirmed": "Last confirmed",
  "manager.lastUsed": "Last used",
  "manager.validity": "Validity",
  "manager.currentVersion": "Current version",
  "manager.never": "Never",
  "manager.notSet": "Not set",
  "manager.evidenceHeading": "Evidence history",
  "manager.evidenceDescription": "Bounded source evidence supporting or contradicting versions of this exact fact. Hidden reasoning is never shown.",
  "manager.evidenceLoading": "Loading evidence…",
  "manager.evidenceError": "Evidence could not be loaded.",
  "manager.evidenceEmpty": "No source evidence is available for this memory.",
  "manager.evidenceMore": "Load more evidence",
  "manager.supports": "Supports",
  "manager.contradicts": "Contradicts",
  "manager.evidenceMessage": "Retained chat message",
  "manager.evidenceAction": "Explicit user action",
  "manager.observed": "Observed",
  "manager.createTitle": "Save a new memory",
  "manager.editTitle": "Edit saved memory",
  "manager.statement": "Exact statement",
  "manager.statementHelp": "AIQSA stores this text exactly as entered. Do not save passwords, access tokens, or other secrets.",
  "manager.categoryHelp": "Lowercase letters, numbers, underscores, or hyphens; start with a letter.",
  "manager.modalityHelp": "Choose the closest factual kind. This does not change the exact statement.",
  "manager.saveNew": "Save memory",
  "manager.saveChanges": "Save changes",
  "manager.cancel": "Cancel",
  "manager.saving": "Saving…",
  "manager.saved": "Saved memory committed.",
  "manager.draftStale": "This memory changed elsewhere. Your draft was kept; review the current version and save again.",
  "manager.validationStatement": "Enter a non-blank statement of 2,000 characters or fewer.",
  "manager.validationCategory": "Enter a valid category or leave it blank when creating a memory.",
  "manager.mutationError": "The Memory action did not complete. Nothing was reported as saved.",
  "manager.secretRejected": "This statement looks like a secret and was not saved.",
  "manager.forgetTitle": "Forget this memory?",
  "manager.forgetDescription": "Future Memory use stops immediately and unchanged evidence is suppressed from relearning. Retained chat text and old accepted runs are not rewritten.",
  "manager.forgetConfirm": "Forget this memory",
  "manager.forgetting": "Forgetting…",
  "manager.forgotten": "Memory fenced from future use; durable plaintext purge is in progress.",
  "manager.deleteHeading": "Delete saved memories",
  "manager.deleteDescription": "Delete every currently saved explicit memory from this account.",
  "manager.deleteTitle": "Delete all saved memories?",
  "manager.deleteExplanation": "This immediately fences all currently saved explicit memories from future retrieval. Their plaintext derivatives are then purged asynchronously.",
  "manager.deleteRetention": "Retained raw chats are not deleted, immutable accepted destination runs are not rewritten, and provider retention or operator backups remain separate.",
  "manager.deleteConfirmation": "Only the currently admitted set is deleted. A memory saved after admission is outside this deletion.",
  "manager.deleteWorking": "Starting durable deletion…",
  "manager.deleteProgress": "Durable deletion progress",
  "manager.deletePending": "Future retrieval is fenced. Physical plaintext purge is queued.",
  "manager.deleteRunning": "Future retrieval is fenced. Physical plaintext purge is running.",
  "manager.deleteRetry": "Future retrieval is fenced. Physical deletion is waiting to retry automatically.",
  "manager.deleteSucceeded": "All admitted saved-memory plaintext derivatives passed the durable deletion audit.",
  "manager.deleteCheckAgain": "Check deletion status",
  "manager.deleteStatusId": "Deletion reference",
  "manager.lastAudit": "Last deletion audit",
  "manager.deleteStale": "Memory changed before deletion admission. Review the current list and confirm again.",
  "manager.savedUseOff": "Saved; memory use is off. The fact is retained but will not be included in answers until Use memory facts is on.",
  "manager.closeDraftWarning": "Unsaved Memory draft",
  "manager.discardTitle": "Discard Memory draft?",
  "manager.discardBody": "The exact statement and metadata in this unsaved draft will be lost.",
  "manager.keepEditing": "Keep editing",
  "manager.discardDraft": "Discard draft",
  "receipt.label": "Memory",
  "receipt.usedOne": "1 memory used",
  "receipt.usedMany": "memories used",
  "receipt.degraded": "retrieval degraded safely",
  "receipt.outcome": "Outcome",
  "receipt.exactText": "Exact included text",
  "receipt.type": "Type",
  "receipt.source": "Source",
  "receipt.sourceUnavailable": "The source conversation is no longer available.",
  "receipt.scope": "Scope",
  "receipt.version": "Version",
  "receipt.selection": "Selection",
  "action.saved": "Memory saved.",
  "action.updated": "Memory updated.",
  "action.forgotten": "Memory forgotten and fenced from future use.",
  "action.ambiguous": "Choose the exact saved memory before AIQSA changes anything.",
  "action.manage": "Manage Memories",
  "common.on": "On",
  "common.off": "Off",
  "common.available": "Available",
  "common.unavailable": "Unavailable"
} satisfies MemoryUiCopyLocale;

const RU = {
  "settings.heading": "Память",
  "settings.intro": "Выберите, что AIQSA может запоминать, и проверяйте точные факты, сохранённые в вашей учётной записи.",
  "settings.loading": "Загрузка настроек Памяти…",
  "settings.loadError": "Не удалось загрузить настройки Памяти.",
  "settings.retry": "Повторить",
  "settings.localeHeading": "Язык Памяти",
  "settings.localeDescription": "Эта настройка учётной записи определяет язык всех элементов управления, подтверждений и состояний Памяти.",
  "settings.localeRu": "Русский",
  "settings.localeEn": "English",
  "settings.policyHeading": "Правила запоминания",
  "settings.policyDescription": "Эти три настройки независимы. Выключение любой из них сохраняет уже записанные данные.",
  "settings.useFactsDescription": "Разрешить добавлять допустимые сохранённые и выученные факты в будущие ответы.",
  "settings.referenceHistoryDescription": "Разрешить поиск по допустимой сохранённой истории чатов как по Памяти, когда эта возможность доступна.",
  "settings.learnAutomaticallyDescription": "Разрешить квалифицированное автоматическое обучение по сохранённым чатам, когда эта возможность доступна.",
  "settings.capabilityReady": "Доступно сейчас",
  "settings.capabilityUnavailable": "Предпочтение сохранено; эта возможность не активна в текущей установке.",
  "settings.capabilitiesHeading": "Текущие возможности",
  "settings.capabilityExplicit": "Явно сохранённые воспоминания",
  "settings.capabilityHistory": "Поиск по истории чатов",
  "settings.capabilityLearning": "Автоматическое обучение",
  "settings.capabilityRussian": "Квалификация русского языка",
  "settings.destinationsHeading": "Назначения данных Памяти",
  "settings.destinationsDescription": "Проверьте текущие назначения до продолжения затронутой внешней обработки Памяти.",
  "settings.answerDestination": "Выбранная модель ответа",
  "settings.systemDestination": "Системная модель Памяти",
  "settings.embeddingDestination": "Развёртывание эмбеддингов",
  "settings.rerankerDestination": "Удалённый реранкер",
  "settings.selectedAtRun": "Выбирается и фиксируется для каждого принятого запуска",
  "settings.destinationUnavailable": "Не настроено или недоступно",
  "settings.currentFingerprint": "Текущий отпечаток назначений",
  "settings.acceptedFingerprint": "Принятый отпечаток назначений",
  "settings.policyVersion": "Версия правил",
  "settings.acceptedAt": "Принято",
  "settings.notAccepted": "Не принято",
  "settings.reviewAction": "Проверить назначения",
  "settings.acceptAction": "Принять текущие назначения",
  "settings.cancelReview": "Закрыть проверку",
  "settings.reviewComplete": "Текущие назначения Памяти приняты.",
  "settings.saved": "Настройка Памяти сохранена.",
  "settings.stale": "Настройки Памяти изменились в другом месте. Загружено текущее состояние сервера.",
  "settings.saveError": "Не удалось сохранить настройку Памяти.",
  "settings.manageDescription": "Проверяйте, добавляйте, исправляйте, закрепляйте или забывайте точные сохранённые факты. Это отдельно от автоматического обучения и истории чатов.",
  "settings.manageUnavailable": "Управление явной Памятью не активно в текущей установке.",
  "manager.title": "Управление памятью",
  "manager.back": "Назад к настройкам Памяти",
  "manager.new": "Новое воспоминание",
  "manager.searchLabel": "Поиск по сохранённым воспоминаниям",
  "manager.searchPlaceholder": "Найти точный сохранённый факт",
  "manager.searchAction": "Найти",
  "manager.clearSearch": "Очистить поиск",
  "manager.loading": "Загрузка сохранённых воспоминаний…",
  "manager.loadError": "Не удалось загрузить сохранённые воспоминания.",
  "manager.retry": "Повторить",
  "manager.empty": "Сохранённых воспоминаний пока нет.",
  "manager.noResults": "По этому запросу ничего не найдено.",
  "manager.loadMore": "Загрузить ещё",
  "manager.loadingMore": "Загрузка…",
  "manager.selectPrompt": "Выберите сохранённое воспоминание, чтобы проверить точный текст и подтверждающие данные.",
  "manager.pinned": "Закреплено",
  "manager.explicit": "Явное сохранение пользователем",
  "manager.global": "Ваша учётная запись",
  "manager.sources": "источников",
  "manager.sourceCount": "Количество источников",
  "manager.updated": "Обновлено",
  "manager.detail": "Сведения о воспоминании",
  "manager.backToList": "Назад к сохранённым воспоминаниям",
  "manager.edit": "Изменить",
  "manager.pin": "Закрепить",
  "manager.unpin": "Открепить",
  "manager.forget": "Забыть",
  "manager.authority": "Источник полномочий",
  "manager.scope": "Область",
  "manager.state": "Состояние",
  "manager.index": "Поисковый индекс",
  "manager.category": "Категория",
  "manager.modality": "Тип",
  "manager.sensitivity": "Чувствительность",
  "manager.created": "Создано",
  "manager.lastConfirmed": "Последнее подтверждение",
  "manager.lastUsed": "Последнее использование",
  "manager.validity": "Период действия",
  "manager.currentVersion": "Текущая версия",
  "manager.never": "Никогда",
  "manager.notSet": "Не задано",
  "manager.evidenceHeading": "История подтверждений",
  "manager.evidenceDescription": "Ограниченные данные источников, подтверждающие или опровергающие версии этого точного факта. Скрытые рассуждения не показываются.",
  "manager.evidenceLoading": "Загрузка подтверждений…",
  "manager.evidenceError": "Не удалось загрузить подтверждения.",
  "manager.evidenceEmpty": "Для этого воспоминания нет доступных подтверждений источника.",
  "manager.evidenceMore": "Загрузить ещё подтверждения",
  "manager.supports": "Подтверждает",
  "manager.contradicts": "Опровергает",
  "manager.evidenceMessage": "Сохранённое сообщение чата",
  "manager.evidenceAction": "Явное действие пользователя",
  "manager.observed": "Зафиксировано",
  "manager.createTitle": "Сохранить новое воспоминание",
  "manager.editTitle": "Изменить сохранённое воспоминание",
  "manager.statement": "Точный текст",
  "manager.statementHelp": "AIQSA сохранит этот текст без изменений. Не сохраняйте пароли, токены доступа и другие секреты.",
  "manager.categoryHelp": "Строчные латинские буквы, цифры, подчёркивания и дефисы; первый символ — буква.",
  "manager.modalityHelp": "Выберите ближайший смысловой тип. Точный текст от этого не изменится.",
  "manager.saveNew": "Сохранить воспоминание",
  "manager.saveChanges": "Сохранить изменения",
  "manager.cancel": "Отмена",
  "manager.saving": "Сохранение…",
  "manager.saved": "Воспоминание сохранено.",
  "manager.draftStale": "Это воспоминание изменилось в другом месте. Черновик сохранён: проверьте текущую версию и повторите сохранение.",
  "manager.validationStatement": "Введите непустой текст длиной не более 2 000 символов.",
  "manager.validationCategory": "Введите допустимую категорию или оставьте поле пустым при создании.",
  "manager.mutationError": "Действие Памяти не завершилось. Сохранение не подтверждено.",
  "manager.secretRejected": "Текст похож на секрет и не был сохранён.",
  "manager.forgetTitle": "Забыть это воспоминание?",
  "manager.forgetDescription": "Будущее использование Памятью прекращается немедленно, а повторное обучение по неизменённым данным подавляется. Сохранённый текст чата и старые принятые запуски не переписываются.",
  "manager.forgetConfirm": "Забыть это воспоминание",
  "manager.forgetting": "Удаление из будущего использования…",
  "manager.forgotten": "Будущее использование заблокировано; идёт гарантированное удаление открытого текста.",
  "manager.deleteHeading": "Удаление сохранённых воспоминаний",
  "manager.deleteDescription": "Удалить все текущие явно сохранённые воспоминания этой учётной записи.",
  "manager.deleteTitle": "Удалить все сохранённые воспоминания?",
  "manager.deleteExplanation": "Все текущие явно сохранённые воспоминания немедленно исключаются из будущего поиска. Затем их производные с открытым текстом удаляются асинхронно.",
  "manager.deleteRetention": "Сохранённые исходные чаты не удаляются, неизменяемые принятые запуски назначения не переписываются, а сроки хранения провайдеров и резервные копии оператора остаются отдельными областями.",
  "manager.deleteConfirmation": "Удаляется только набор, зафиксированный при запуске операции. Воспоминание, сохранённое позже, в него не входит.",
  "manager.deleteWorking": "Запуск гарантированного удаления…",
  "manager.deleteProgress": "Ход гарантированного удаления",
  "manager.deletePending": "Будущий поиск заблокирован. Физическое удаление открытого текста поставлено в очередь.",
  "manager.deleteRunning": "Будущий поиск заблокирован. Выполняется физическое удаление открытого текста.",
  "manager.deleteRetry": "Будущий поиск заблокирован. Физическое удаление ожидает автоматической повторной попытки.",
  "manager.deleteSucceeded": "Все производные с открытым текстом из принятого набора прошли аудит гарантированного удаления.",
  "manager.deleteCheckAgain": "Проверить состояние удаления",
  "manager.deleteStatusId": "Идентификатор удаления",
  "manager.lastAudit": "Последний аудит удаления",
  "manager.deleteStale": "Память изменилась до запуска удаления. Проверьте текущий список и подтвердите действие снова.",
  "manager.savedUseOff": "Сохранено; использование памяти выключено. Факт останется сохранённым, но не попадёт в ответы, пока настройка «Использовать факты из памяти» не включена.",
  "manager.closeDraftWarning": "Несохранённый черновик Памяти",
  "manager.discardTitle": "Отменить изменения Памяти?",
  "manager.discardBody": "Точный текст и метаданные этого несохранённого черновика будут потеряны.",
  "manager.keepEditing": "Продолжить редактирование",
  "manager.discardDraft": "Отменить изменения",
  "receipt.label": "Память",
  "receipt.usedOne": "Использовано 1 воспоминание",
  "receipt.usedMany": "Использовано воспоминаний",
  "receipt.degraded": "поиск безопасно продолжен в ограниченном режиме",
  "receipt.outcome": "Результат",
  "receipt.exactText": "Точный добавленный текст",
  "receipt.type": "Тип",
  "receipt.source": "Источник",
  "receipt.sourceUnavailable": "Исходный разговор больше недоступен.",
  "receipt.scope": "Область",
  "receipt.version": "Версия",
  "receipt.selection": "Причина выбора",
  "action.saved": "Воспоминание сохранено.",
  "action.updated": "Воспоминание обновлено.",
  "action.forgotten": "Воспоминание забыто и исключено из будущего использования.",
  "action.ambiguous": "Выберите точное сохранённое воспоминание, прежде чем AIQSA что-либо изменит.",
  "action.manage": "Управление памятью",
  "common.on": "Вкл.",
  "common.off": "Выкл.",
  "common.available": "Доступно",
  "common.unavailable": "Недоступно"
} satisfies MemoryUiCopyLocale;

export const MEMORY_UI_COPY: Readonly<Record<MemoryUiLocale, MemoryUiCopyLocale>> =
  Object.freeze({ EN: Object.freeze(EN), RU: Object.freeze(RU) });

export function memoryUiCopy(locale: MemoryUiLocale, key: MemoryUiCopyKey): string {
  const value = MEMORY_UI_COPY[locale][key];
  if (!value) throw new Error(`memory_ui_copy_missing:${locale}:${key}`);
  return value;
}

const FACT_STATE_LABELS: Readonly<Record<MemoryUiLocale, Readonly<Record<MemoryFactState, string>>>> = {
  EN: {
    ACTIVE: "Active",
    CONFLICTED: "Conflicted",
    EXPIRED: "Expired",
    FORGOTTEN: "Forgotten",
    ORPHANED: "Orphaned",
    RETRACTED: "Retracted"
  },
  RU: {
    ACTIVE: "Активно",
    CONFLICTED: "Есть конфликт",
    EXPIRED: "Срок истёк",
    FORGOTTEN: "Забыто",
    ORPHANED: "Источник недоступен",
    RETRACTED: "Отозвано"
  }
};

const MODALITY_LABELS: Readonly<Record<MemoryUiLocale, Readonly<Record<MemoryModality, string>>>> = {
  EN: {
    CONSIDERATION: "Consideration",
    CONSTRAINT: "Constraint",
    EVENT: "Event",
    HABIT: "Habit",
    INTENTION: "Intention",
    PLAN: "Plan",
    PREFERENCE: "Preference",
    STATE: "State",
    WORKFLOW: "Workflow"
  },
  RU: {
    CONSIDERATION: "Соображение",
    CONSTRAINT: "Ограничение",
    EVENT: "Событие",
    HABIT: "Привычка",
    INTENTION: "Намерение",
    PLAN: "План",
    PREFERENCE: "Предпочтение",
    STATE: "Состояние",
    WORKFLOW: "Рабочий процесс"
  }
};

const SENSITIVITY_LABELS: Readonly<
  Record<MemoryUiLocale, Readonly<Record<MemorySensitivityClass, string>>>
> = {
  EN: {
    HIGHLY_SENSITIVE: "Highly sensitive",
    NORMAL: "Normal",
    SECRET: "Secret",
    SENSITIVE: "Sensitive"
  },
  RU: {
    HIGHLY_SENSITIVE: "Особо чувствительные данные",
    NORMAL: "Обычные данные",
    SECRET: "Секрет",
    SENSITIVE: "Чувствительные данные"
  }
};

export function memoryFactStateLabel(locale: MemoryUiLocale, value: MemoryFactState): string {
  return FACT_STATE_LABELS[locale][value];
}

export function memoryModalityLabel(locale: MemoryUiLocale, value: MemoryModality): string {
  return MODALITY_LABELS[locale][value];
}

export function memorySensitivityLabel(
  locale: MemoryUiLocale,
  value: MemorySensitivityClass
): string {
  return SENSITIVITY_LABELS[locale][value];
}

const RECEIPT_ITEM_TYPE_LABELS: Readonly<
  Record<MemoryUiLocale, Readonly<Record<MemoryReceiptItemType, string>>>
> = {
  EN: {
    EPISODE: "Previous-chat episode",
    FACT_VERSION: "Saved fact version",
    PROFILE: "Memory summary",
    RECALL_CHUNK: "Previous-chat excerpt"
  },
  RU: {
    EPISODE: "Эпизод из предыдущего чата",
    FACT_VERSION: "Версия сохранённого факта",
    PROFILE: "Сводка Памяти",
    RECALL_CHUNK: "Фрагмент предыдущего чата"
  }
};

const RECEIPT_SOURCE_MODE_LABELS: Readonly<
  Record<MemoryUiLocale, Readonly<Record<MemoryReceiptItem["sourceMode"], string>>>
> = {
  EN: {
    AUTOMATIC: "Automatically learned evidence",
    EXPLICIT: "Explicit user action",
    HISTORY: "Retained chat history",
    PROFILE: "Derived Memory summary"
  },
  RU: {
    AUTOMATIC: "Автоматически изученные данные",
    EXPLICIT: "Явное действие пользователя",
    HISTORY: "Сохранённая история чатов",
    PROFILE: "Производная сводка Памяти"
  }
};

const RECEIPT_SCOPE_LABELS: Readonly<
  Record<MemoryUiLocale, Readonly<Record<MemoryScopeType, string>>>
> = {
  EN: {
    ASSISTANT: "Assistant",
    CHAT: "Chat",
    FOLDER: "Folder",
    GLOBAL_USER: "Your account"
  },
  RU: {
    ASSISTANT: "Ассистент",
    CHAT: "Чат",
    FOLDER: "Папка",
    GLOBAL_USER: "Ваша учётная запись"
  }
};

const RECEIPT_LIFECYCLE_LABELS: Readonly<
  Record<MemoryUiLocale, Readonly<Record<MemoryReceiptLifecycleState, string>>>
> = {
  EN: {
    CURRENT: "Current",
    LATER_FORGOTTEN: "Later forgotten",
    SOURCE_DELETED: "Source deleted"
  },
  RU: {
    CURRENT: "Текущее",
    LATER_FORGOTTEN: "Позже забыто",
    SOURCE_DELETED: "Источник удалён"
  }
};

export function memoryReceiptItemTypeLabel(
  locale: MemoryUiLocale,
  value: MemoryReceiptItemType
): string {
  return RECEIPT_ITEM_TYPE_LABELS[locale][value];
}

export function memoryReceiptSourceModeLabel(
  locale: MemoryUiLocale,
  value: MemoryReceiptItem["sourceMode"]
): string {
  return RECEIPT_SOURCE_MODE_LABELS[locale][value];
}

export function memoryReceiptScopeLabel(
  locale: MemoryUiLocale,
  value: MemoryScopeType
): string {
  return RECEIPT_SCOPE_LABELS[locale][value];
}

export function memoryReceiptLifecycleLabel(
  locale: MemoryUiLocale,
  value: MemoryReceiptLifecycleState
): string {
  return RECEIPT_LIFECYCLE_LABELS[locale][value];
}

function russianCount(
  count: number,
  forms: Readonly<[string, string, string]>
): string {
  const modulo100 = count % 100;
  const modulo10 = count % 10;
  const form = modulo100 >= 11 && modulo100 <= 14
    ? forms[2]
    : modulo10 === 1 ? forms[0] : modulo10 >= 2 && modulo10 <= 4
      ? forms[1]
      : forms[2];
  return `${count} ${form}`;
}

/** Compact, locale-aware evidence summary without exposing source identities. */
export function memoryReceiptUsageLabel(
  locale: MemoryUiLocale,
  receipt: MemoryReceipt
): string {
  const reusableCount = receipt.items.filter((item) =>
    item.itemType === "FACT_VERSION" || item.itemType === "PROFILE").length;
  const historyItems = receipt.items.filter((item) =>
    item.itemType === "EPISODE" || item.itemType === "RECALL_CHUNK");
  const knownChats = new Set(historyItems.flatMap((item) =>
    item.sourceChatId ? [item.sourceChatId] : []));
  const historyCount = knownChats.size + historyItems.filter((item) =>
    item.sourceChatId === null).length;

  if (historyCount === 0) {
    return reusableCount === 1
      ? memoryUiCopy(locale, "receipt.usedOne")
      : `${memoryUiCopy(locale, "receipt.usedMany")}: ${reusableCount}`;
  }
  if (locale === "RU") {
    const history = russianCount(historyCount, [
      "предыдущий чат",
      "предыдущих чата",
      "предыдущих чатов"
    ]);
    if (reusableCount === 0) return `Использовано: ${history}`;
    const reusable = russianCount(reusableCount, [
      "воспоминание",
      "воспоминания",
      "воспоминаний"
    ]);
    return `Использовано: ${reusable} и ${history}`;
  }
  const history = `${historyCount} previous ${historyCount === 1 ? "chat" : "chats"}`;
  if (reusableCount === 0) return `${history} used`;
  const reusable = `${reusableCount} ${reusableCount === 1 ? "memory" : "memories"}`;
  return `${reusable} and ${history} used`;
}
