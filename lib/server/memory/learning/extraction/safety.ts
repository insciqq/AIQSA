import { normalizeMemorySearchText } from "../../persistence/lexical";

const sensitiveCategoryPattern = new RegExp([
  "(?:diagnos|medical|health|illness|disabilit|pregnan|therapy|medication)",
  "(?:диагноз|здоров|болезн|инвалид|беремен|терап|лекарств)",
  "(?:religion|religious|faith|church|mosque|synagogue)",
  "(?:религи|вероисповед|церк|мечет|синагог)",
  "(?:politic|party member|vot(?:e|ing)|union member)",
  "(?:политич|партии|голосова|профсоюз)",
  "(?:sexual orientation|sex life|gender identity|ethnic|race|racial)",
  "(?:сексуальн|половая жизнь|гендерн|этнич|расов)",
  "(?:criminal|lawsuit|legal case|conviction|arrest)",
  "(?:уголовн|судебн|иск|судимость|арест)",
  "(?:salary|income|debt|bank|credit|mortgage|investment account)",
  "(?:зарплат|доход|долг|банк|кредит|ипотек|инвестиц)",
  "(?:home address|street address|live at|reside at)",
  "(?:домашн(?:ий|его) адрес|адрес проживания|живу по адресу)"
].join("|"), "iu");

const instructionPattern = /(?:^|[\n.!?])\s*(?:(?:(?:can|could|would) you\s+)?(?:please\s*,?\s+)?(?:write|say|translate|summarize|pretend|imagine|roleplay|quote|ignore|disregard)|(?:(?:пожалуйста|можешь|можете|мог бы|могла бы)\s*,?\s+)?(?:напиши|скаж(?:и|ите)|переведи|суммаризируй|представь|сыграй роль|процитируй|игнорируй|запомни как системную инструкцию))(?=$|[^\p{L}\p{N}_])/iu;
const quotationPattern = /(?:```|`|["“”„«»‘’]|(?:^|\n)\s*>)/u;
const reportedSpeechPattern = /(?:said|says|told|wrote|quoted|сказал(?:а|и)?|говорит|написал(?:а|и)?|процитировал(?:а|и)?)\s*(?:[:,]|that(?=$|[^\p{L}\p{N}_])|что(?=$|[^\p{L}\p{N}_])|i(?=$|[^\p{L}\p{N}_])|my(?=$|[^\p{L}\p{N}_])|я(?=$|[^\p{L}\p{N}_])|м(?:ой|оя|оё|ои)(?=$|[^\p{L}\p{N}_]))/iu;
const hypotheticalPattern = /(?:^|[^\p{L}\p{N}_])(?:if i were|suppose i|imagine i|hypothetically|если бы я|допустим[, ]+я|представим[, ]+что я|гипотетически)(?=$|[^\p{L}\p{N}_])/iu;

export type MemoryFactSourceSafety = Readonly<{
  eligible: boolean;
  reasonCode: string | null;
}>;

export function inspectMemoryFactSourceSafety(
  text: string
): MemoryFactSourceSafety {
  const normalized = normalizeMemorySearchText(text);
  if (!normalized || sensitiveCategoryPattern.test(normalized)) {
    return { eligible: false, reasonCode: "sensitive_category_excluded" };
  }
  if (
    instructionPattern.test(text) || quotationPattern.test(text) ||
    reportedSpeechPattern.test(text) || hypotheticalPattern.test(text)
  ) {
    return { eligible: false, reasonCode: "instruction_or_hypothetical_excluded" };
  }
  return { eligible: true, reasonCode: null };
}

export function memoryFactCandidateSensitivityAllowed(
  sourceText: string,
  category: string,
  displayText: string
): boolean {
  return !sensitiveCategoryPattern.test(
    `${sourceText}\n${category}\n${displayText}`
  );
}
