import { createHash } from "node:crypto";
import {
  knowledgeRerankerCorpusManifestSchema,
  knowledgeRerankerDatasetSplits,
  type KnowledgeRerankerCorpusDocument,
  type KnowledgeRerankerCorpusManifest,
  type KnowledgeRerankerCorpusQuery,
  type KnowledgeRerankerDatasetSplit,
  type KnowledgeRerankerLanguage
} from "./rerankerCorpusSchema";

export const KNOWLEDGE_RERANKER_CORPUS_VERSION = "knowledge-reranker-corpus-v1" as const;
export const KNOWLEDGE_RERANKER_FROZEN_CORPUS_SHA256 =
  "1738d051c5a16a4ec38de9f3035d3bc42db98ae06bbdb88ebff532fe33f408b6" as const;

type TopicDefinition = Readonly<{
  englishFacts: readonly string[];
  englishQuery: string;
  englishTitle: string;
  russianFacts: readonly string[];
  russianQuery: string;
  russianTitle: string;
  slug: string;
  split: KnowledgeRerankerDatasetSplit;
}>;

const topics: readonly TopicDefinition[] = Object.freeze([
  Object.freeze({
    englishFacts: [
      "The weekday dispatch cutoff is 16:40 UTC; later sealed manifests move to the next operating day.",
      "Violet labels identify refrigerated cases, while ordinary cases retain the white routing label.",
      "The western dock accepts manifest corrections only before the carrier signs the departure receipt.",
      "A weather hold is recorded against the shipment identifier and does not create a replacement shipment.",
      "The night audit compares loaded case counts with the signed manifest before closing the departure window."
    ],
    englishQuery: "What is the weekday dispatch cutoff for a sealed Northwind manifest?",
    englishTitle: "Northwind dispatch controls",
    russianFacts: [
      "Исправления после подписи перевозчика регистрируются отдельным замечанием и не меняют исходный манифест.",
      "Для срочного согласования задержки используется канал NW-OPS-7, а не общий почтовый ящик.",
      "Фиолетовая этикетка означает охлаждаемый груз и требует повторной проверки температуры перед отправкой.",
      "Ночная сверка сопоставляет число мест с подписанным манифестом и журналом погрузочной зоны.",
      "Погодная задержка сохраняет исходный идентификатор отправки и получает отдельную временную отметку."
    ],
    russianQuery: "Какой канал используется для срочного согласования задержки Northwind?",
    russianTitle: "Правила отправки Northwind",
    slug: "northwind-dispatch",
    split: "development"
  }),
  Object.freeze({
    englishFacts: [
      "Pump C-14 receives a vibration inspection every 18 days and a full seal inspection every 72 days.",
      "Technicians isolate the blue return valve before opening the Cedar pressure housing.",
      "A completed inspection retains the original work order even when a follow-up repair is scheduled.",
      "The calibration wrench is stored in cabinet 4B and is checked at the start of each shift.",
      "An amber status tag permits diagnostics but blocks the pump from returning to production service."
    ],
    englishQuery: "How often does Cedar pump C-14 receive a vibration inspection?",
    englishTitle: "Cedar maintenance ledger",
    russianFacts: [
      "Перед открытием корпуса техник перекрывает синий обратный клапан и подтверждает нулевое давление.",
      "Контрольный динамометр хранится в шкафу 4B и проверяется в начале каждой смены.",
      "Полная проверка уплотнения выполняется каждые 72 дня независимо от промежуточной диагностики.",
      "Жёлтая бирка разрешает диагностику, но запрещает возвращать насос в рабочий контур.",
      "Повторный ремонт ссылается на исходный заказ и не создаёт вторую запись выполненного осмотра."
    ],
    russianQuery: "Где хранится контрольный динамометр для обслуживания Cedar?",
    russianTitle: "Журнал обслуживания Cedar",
    slug: "cedar-maintenance",
    split: "development"
  }),
  Object.freeze({
    englishFacts: [
      "Temporary Lagoon access expires after six hours and cannot be extended without a new sponsor approval.",
      "Visitor badges open the archive vestibule but never the controlled records room.",
      "The sponsor confirms the visitor identity at desk L2 before any badge is encoded.",
      "Lost badges are disabled against their original badge number before a replacement is prepared.",
      "Weekend access requires both a named sponsor and an on-duty facilities contact."
    ],
    englishQuery: "How long does temporary Lagoon access remain valid?",
    englishTitle: "Lagoon access handbook",
    russianFacts: [
      "Гостевой пропуск открывает тамбур архива, но не помещение контролируемых записей.",
      "Личность посетителя подтверждается спонсором на стойке L2 до программирования пропуска.",
      "Утерянный пропуск отключается по исходному номеру до выдачи замены.",
      "Для доступа в выходной нужны названный спонсор и дежурный сотрудник службы эксплуатации.",
      "Временный доступ действует шесть часов и требует нового согласования для следующего периода."
    ],
    russianQuery: "На какой стойке спонсор подтверждает личность посетителя Lagoon?",
    russianTitle: "Порядок доступа Lagoon",
    slug: "lagoon-access",
    split: "development"
  }),
  Object.freeze({
    englishFacts: [
      "Harbor export bundles are retained for 41 days after the completion receipt is signed.",
      "A legal hold suspends expiry for the named bundle without changing the retention rule for other exports.",
      "Deletion confirmation records the bundle checksum and the completion receipt identifier.",
      "A failed export has no retention clock until a successful completion receipt exists.",
      "The monthly audit samples five completed bundles from each operating region."
    ],
    englishQuery: "For how many days are completed Harbor export bundles retained?",
    englishTitle: "Harbor retention schedule",
    russianFacts: [
      "Срок хранения начинается после подписания квитанции об успешном завершении выгрузки.",
      "Подтверждение удаления содержит контрольную сумму комплекта и номер квитанции завершения.",
      "Юридическая блокировка приостанавливает удаление только для указанного комплекта данных.",
      "Неуспешная выгрузка не получает срок хранения до появления успешной квитанции.",
      "Ежемесячная проверка выбирает по пять завершённых комплектов из каждого рабочего региона."
    ],
    russianQuery: "Что фиксируется в подтверждении удаления комплекта Harbor?",
    russianTitle: "Сроки хранения Harbor",
    slug: "harbor-retention",
    split: "calibration"
  }),
  Object.freeze({
    englishFacts: [
      "Birch purchases above 8,500 USD require a finance reviewer who did not submit the original request.",
      "A sole-source justification names the supplier and explains why the normal comparison was unavailable.",
      "Purchase amendments preserve the first request number and add a sequential amendment suffix.",
      "Receiving staff record damaged cartons before acknowledging the accepted quantity.",
      "A cancelled request cannot be reopened; the requester creates a new request with a fresh identifier."
    ],
    englishQuery: "At what amount does a Birch purchase require an independent finance reviewer?",
    englishTitle: "Birch procurement standard",
    russianFacts: [
      "Обоснование единственного поставщика называет поставщика и причину отсутствия обычного сравнения.",
      "Изменение закупки сохраняет исходный номер заявки и получает последовательный суффикс.",
      "Повреждённые коробки фиксируются до подтверждения принятого количества товара.",
      "Отменённая заявка не открывается повторно; создаётся новая заявка с новым идентификатором.",
      "Финансовый проверяющий не должен быть автором исходной заявки на закупку."
    ],
    russianQuery: "Как нумеруется изменение уже созданной закупки Birch?",
    russianTitle: "Стандарт закупок Birch",
    slug: "birch-procurement",
    split: "calibration"
  }),
  Object.freeze({
    englishFacts: [
      "Summit severity-one incidents page the primary responder after four minutes without acknowledgement.",
      "The incident commander records the customer-impact boundary before requesting a status broadcast.",
      "A recovered dependency remains under observation for thirty minutes before the incident is resolved.",
      "The communications lead publishes only confirmed scope and marks estimates as provisional.",
      "A handoff keeps the original incident number and names both the outgoing and incoming commanders."
    ],
    englishQuery: "When is the primary responder paged for an unacknowledged Summit severity-one incident?",
    englishTitle: "Summit escalation protocol",
    russianFacts: [
      "Перед общей рассылкой руководитель инцидента фиксирует подтверждённую границу влияния на клиентов.",
      "Восстановленная зависимость наблюдается тридцать минут до закрытия инцидента.",
      "Ответственный за коммуникации публикует подтверждённый охват, а оценки помечает как предварительные.",
      "При передаче сохраняется исходный номер и указываются оба руководителя инцидента.",
      "Если подтверждения нет четыре минуты, вызывается основной дежурный специалист."
    ],
    russianQuery: "Сколько наблюдают восстановленную зависимость перед закрытием Summit-инцидента?",
    russianTitle: "Протокол эскалации Summit",
    slug: "summit-escalation",
    split: "held_out"
  }),
  Object.freeze({
    englishFacts: [
      "Orchid evidence samples are sealed at 17:15 local time on the final business day of each month.",
      "The sample owner and reviewer sign separate fields on the evidence cover sheet.",
      "A substituted sample records both the rejected item and the documented replacement reason.",
      "Read-only audit copies carry the original checksum and an explicit non-authoritative marker.",
      "Unresolved exceptions remain open in the next cycle and are never silently removed from the ledger."
    ],
    englishQuery: "At what time are monthly Orchid evidence samples sealed?",
    englishTitle: "Orchid audit procedure",
    russianFacts: [
      "Замена элемента фиксирует отклонённый элемент и документированную причину замены.",
      "Владелец выборки и проверяющий подписывают разные поля на титульном листе доказательств.",
      "Копия только для чтения содержит исходную контрольную сумму и отметку о неавторитетности.",
      "Нерешённые исключения переносятся в следующий цикл и остаются в журнале.",
      "Месячная выборка запечатывается в последний рабочий день после завершения всех подписей."
    ],
    russianQuery: "Какие две роли подписывают титульный лист выборки Orchid?",
    russianTitle: "Процедура аудита Orchid",
    slug: "orchid-audit",
    split: "held_out"
  }),
  Object.freeze({
    englishFacts: [
      "Quartz signing keys rotate every 93 days, with a seven-day verification overlap for the retiring key.",
      "The rotation owner verifies one signature in each region before publishing the new active key.",
      "A compromised key bypasses the normal schedule and enters immediate revocation handling.",
      "Archived verification records contain key identifiers but never private key material.",
      "Rollback is permitted only while the retiring key remains inside its verification overlap."
    ],
    englishQuery: "What is the normal Quartz signing-key rotation interval?",
    englishTitle: "Quartz key rotation record",
    russianFacts: [
      "Перед публикацией нового ключа владелец проверяет по одной подписи в каждом регионе.",
      "Для уходящего ключа сохраняется семидневный период проверки уже созданных подписей.",
      "Скомпрометированный ключ немедленно отзывается вне обычного графика.",
      "Архив проверки содержит идентификаторы ключей, но не закрытый ключевой материал.",
      "Откат разрешён только пока уходящий ключ находится в периоде проверки."
    ],
    russianQuery: "Какой период проверки сохраняется для уходящего ключа Quartz?",
    russianTitle: "Ротация ключей Quartz",
    slug: "quartz-rotation",
    split: "held_out"
  }),
  Object.freeze({
    englishFacts: [
      "Tundra safety certification remains current for eleven months after the practical assessment.",
      "A missed practical assessment cannot be replaced by the online knowledge quiz alone.",
      "Supervisors verify certification status before assigning work in the marked cold-storage zone.",
      "Training corrections preserve the original result and append the instructor's signed note.",
      "Visitors receive a separate escort briefing that does not grant worker certification."
    ],
    englishQuery: "How long does Tundra safety certification remain current after assessment?",
    englishTitle: "Tundra training handbook",
    russianFacts: [
      "Руководитель проверяет статус допуска до назначения работы в отмеченной холодной зоне.",
      "Пропущенную практическую оценку нельзя заменить только электронным тестом знаний.",
      "Исправление сохраняет исходный результат и добавляет подписанное примечание инструктора.",
      "Посетитель проходит отдельный инструктаж с сопровождением, который не даёт рабочего допуска.",
      "Допуск действует одиннадцать месяцев после успешной практической оценки."
    ],
    russianQuery: "Может ли электронный тест заменить практическую оценку Tundra?",
    russianTitle: "Учебное руководство Tundra",
    slug: "tundra-training",
    split: "blinded_review"
  }),
  Object.freeze({
    englishFacts: [
      "Willow cycle counts begin at aisle W-12 and proceed in ascending bin order.",
      "A quantity variance above three units requires a second counter before adjustment.",
      "Damaged inventory remains in its original bin record while its physical stock is quarantined.",
      "The count lead closes a zone only after every skipped bin has a documented reason.",
      "Transfer-in-transit items are reconciled against the departure receipt, not counted as available stock."
    ],
    englishQuery: "Where does the Willow cycle count begin?",
    englishTitle: "Willow inventory count",
    russianFacts: [
      "Повреждённый товар остаётся в исходной записи ячейки, а физический запас помещается в карантин.",
      "Расхождение больше трёх единиц требует повторного пересчёта другим сотрудником.",
      "Зона закрывается только после документирования причины для каждой пропущенной ячейки.",
      "Товар в перемещении сверяется с квитанцией отправки и не считается доступным запасом.",
      "Пересчёт начинается с прохода W-12 и продолжается по возрастанию номеров ячеек."
    ],
    russianQuery: "Когда расхождение Willow требует второго счётчика?",
    russianTitle: "Инвентаризация Willow",
    slug: "willow-inventory",
    split: "blinded_review"
  })
]);

const noAnswerQueries: readonly Readonly<{
  language: KnowledgeRerankerLanguage;
  slug: string;
  split: KnowledgeRerankerDatasetSplit;
  text: string;
}>[] = Object.freeze([
  Object.freeze({
    language: "en",
    slug: "zephyr-launch-code",
    split: "development",
    text: "What is the production launch code assigned to Project Zephyr?"
  }),
  Object.freeze({
    language: "ru",
    slug: "amber-insurance",
    split: "calibration",
    text: "Какой номер страхового полиса назначен программе Amber?"
  }),
  Object.freeze({
    language: "en",
    slug: "meridian-catering",
    split: "held_out",
    text: "Which catering vendor serves the Meridian annual conference?"
  }),
  Object.freeze({
    language: "ru",
    slug: "solstice-rent",
    split: "blinded_review",
    text: "Какова ежемесячная арендная плата офиса Solstice?"
  })
]);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function passageText(input: Readonly<{
  fact: string;
  language: KnowledgeRerankerLanguage;
  sequence: number;
  title: string;
}>): readonly [string, string] {
  if (input.language === "en") {
    return [
      `${input.title}. This repository-generated operating record describes one bounded control in a fictional organization. ${input.fact} The observation is tied to record ${String(input.sequence).padStart(2, "0")}; a later amendment must preserve that identity and state its effective date.`,
      `Verification note for record ${String(input.sequence).padStart(2, "0")}. Reviewers compare the stated scope, actor, timing, identifier, and exception before relying on the control. Repeated headings are navigation only, and an unavailable fact must be reported as unavailable rather than inferred from a neighboring record.`
    ];
  }
  return [
    `${input.title}. Эта сгенерированная запись описывает одно ограниченное правило вымышленной организации. ${input.fact} Наблюдение связано с записью ${String(input.sequence).padStart(2, "0")}; последующее изменение обязано сохранить её идентификатор и указать дату действия.`,
    `Проверочная заметка для записи ${String(input.sequence).padStart(2, "0")}. Проверяющий отдельно сопоставляет область, роль, срок, идентификатор и исключение. Повторяющийся заголовок служит только навигацией, а отсутствующий факт нельзя выводить из соседней записи.`
  ];
}

function createDocuments(): KnowledgeRerankerCorpusDocument[] {
  let documentOrdinal = 0;
  let passageOrdinal = 0;
  return topics.flatMap((topic) => Array.from({ length: 5 }, (_, index) => {
    documentOrdinal += 1;
    const language: KnowledgeRerankerLanguage = index % 2 === 0 ? "en" : "ru";
    const title = language === "en" ? topic.englishTitle : topic.russianTitle;
    const fact = language === "en" ? topic.englishFacts[index]! : topic.russianFacts[index]!;
    const texts = passageText({ fact, language, sequence: documentOrdinal, title });
    const passages = texts.map((text, passageIndex) => {
      passageOrdinal += 1;
      return Object.freeze({
        contentSha256: sha256(text),
        id: `kr-passage-${String(passageOrdinal).padStart(3, "0")}`,
        ordinal: passageIndex + 1,
        text
      });
    });
    return Object.freeze({
      contentSafety: Object.freeze({
        license: "AGPL-3.0-only" as const,
        origin: "repository_generated" as const,
        privateOperatorDocuments: false as const,
        privateUserContent: false as const
      }),
      documentFamily: `kr-${topic.slug}-family-v1`,
      id: `kr-document-${String(documentOrdinal).padStart(2, "0")}`,
      language,
      passages: Object.freeze(passages) as unknown as KnowledgeRerankerCorpusDocument["passages"],
      semanticTemplateFamily: `kr-${topic.slug}-template-v1`,
      split: topic.split,
      title
    });
  }));
}

function createQueries(): KnowledgeRerankerCorpusQuery[] {
  const definitions = topics.flatMap((topic) => [
    {
      language: "en" as const,
      queryFamily: `kr-${topic.slug}-query-family-v1`,
      split: topic.split,
      text: topic.englishQuery
    },
    {
      language: "ru" as const,
      queryFamily: `kr-${topic.slug}-query-family-v1`,
      split: topic.split,
      text: topic.russianQuery
    }
  ]).concat(noAnswerQueries.map((query) => ({
    language: query.language,
    queryFamily: `kr-${query.slug}-query-family-v1`,
    split: query.split,
    text: query.text
  })));
  return definitions.map((query, index) => Object.freeze({
    contentSha256: sha256(query.text),
    id: `kr-query-${String(index + 1).padStart(2, "0")}`,
    ...query
  }));
}

function corpusDigest(
  documents: readonly KnowledgeRerankerCorpusDocument[],
  queries: readonly KnowledgeRerankerCorpusQuery[]
): string {
  return sha256(JSON.stringify({ documents, queries }));
}

function assertFamilySeparation(
  documents: readonly KnowledgeRerankerCorpusDocument[],
  queries: readonly KnowledgeRerankerCorpusQuery[]
): void {
  const familySplits = new Map<string, Set<KnowledgeRerankerDatasetSplit>>();
  for (const item of [...documents.map((document) => ({
    family: document.documentFamily,
    split: document.split
  })), ...queries.map((query) => ({ family: query.queryFamily, split: query.split }))]) {
    const splits = familySplits.get(item.family) ?? new Set();
    splits.add(item.split);
    familySplits.set(item.family, splits);
  }
  if ([...familySplits.values()].some((splits) => splits.size !== 1)) {
    throw new Error("knowledge_reranker_corpus_family_split_leakage");
  }
  for (const split of knowledgeRerankerDatasetSplits) {
    const languages = new Set(queries.filter((query) => query.split === split)
      .map((query) => query.language));
    if (!languages.has("en") || !languages.has("ru")) {
      throw new Error(`knowledge_reranker_corpus_language_split_missing:${split}`);
    }
  }
}

export function createKnowledgeRerankerCorpusManifest(): KnowledgeRerankerCorpusManifest {
  const documents = createDocuments();
  const queries = createQueries();
  assertFamilySeparation(documents, queries);
  const actualDigest = corpusDigest(documents, queries);
  if (actualDigest !== KNOWLEDGE_RERANKER_FROZEN_CORPUS_SHA256) {
    throw new Error(`knowledge_reranker_frozen_corpus_digest_mismatch:${actualDigest}`);
  }
  return knowledgeRerankerCorpusManifestSchema.parse({
    corpusSha256: actualDigest,
    documents,
    languages: ["en", "ru"],
    queries,
    splitPolicy: {
      assignmentUnit: "document_and_query_family",
      blindedReviewMayTuneModelsOrThresholds: false,
      calibrationMayTuneThresholds: true,
      developmentMayTuneImplementation: true,
      familyAssignmentsFrozen: true,
      heldOutMayTuneModelsOrThresholds: false
    },
    version: KNOWLEDGE_RERANKER_CORPUS_VERSION
  });
}

export type KnowledgeRerankerCorpusAssessment = Readonly<{
  benchmarkQualityEligible: false;
  documentCount: 50;
  familyLeakage: false;
  humanLabels: "not_collected";
  queryCount: number;
  splitCounts: Readonly<Record<KnowledgeRerankerDatasetSplit, Readonly<{
    documents: number;
    englishQueries: number;
    queries: number;
    russianQueries: number;
  }>>>;
}>;

export function assessKnowledgeRerankerCorpus(
  manifest: KnowledgeRerankerCorpusManifest
): KnowledgeRerankerCorpusAssessment {
  const splitCounts = Object.fromEntries(knowledgeRerankerDatasetSplits.map((split) => {
    const queries = manifest.queries.filter((query) => query.split === split);
    return [split, Object.freeze({
      documents: manifest.documents.filter((document) => document.split === split).length,
      englishQueries: queries.filter((query) => query.language === "en").length,
      queries: queries.length,
      russianQueries: queries.filter((query) => query.language === "ru").length
    })];
  })) as Record<KnowledgeRerankerDatasetSplit, {
    documents: number;
    englishQueries: number;
    queries: number;
    russianQueries: number;
  }>;
  return Object.freeze({
    benchmarkQualityEligible: false,
    documentCount: 50,
    familyLeakage: false,
    humanLabels: "not_collected",
    queryCount: manifest.queries.length,
    splitCounts: Object.freeze(splitCounts)
  });
}
