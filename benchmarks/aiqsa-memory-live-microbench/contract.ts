import { resolve, sep } from "node:path";

export const AIQSA_MEMORY_LIVE_MICROBENCH_VERSION = 3 as const;
export const AIQSA_MEMORY_LIVE_MICROBENCH_ACK =
  "DISPOSABLE_PAID_AIQSA_MEMORY_LIVE" as const;
export const AIQSA_MEMORY_LIVE_DEFAULT_SYSTEM_MODEL_ID = "gpt-5.6-sol" as const;
export const AIQSA_MEMORY_LIVE_SYSTEM_MODEL_IDS = Object.freeze([
  "gpt-5.6-sol",
  "gpt-5.6-luna"
] as const);
export const AIQSA_MEMORY_LIVE_SOURCE_CHAT_COUNT = 13 as const;
export const AIQSA_MEMORY_LIVE_SOURCE_SEND_COUNT = 13 as const;
export const AIQSA_MEMORY_LIVE_RECALL_SEND_COUNT = 3 as const;

export type LiveSystemModelId =
  (typeof AIQSA_MEMORY_LIVE_SYSTEM_MODEL_IDS)[number];

export function decodeLiveSystemModelId(value: string | undefined): LiveSystemModelId {
  if (AIQSA_MEMORY_LIVE_SYSTEM_MODEL_IDS.some((candidate) => candidate === value)) {
    return value as LiveSystemModelId;
  }
  throw new Error("aiqsa_memory_live_system_model_invalid");
}

export type LiveSourceChat = Readonly<{
  id: string;
  messages: readonly string[];
  title: string;
}>;

export type LiveRecall = Readonly<{
  id: "dream-routine" | "team-lead" | "tablecloth";
  prompt: string;
  requiredAnswerGroups: readonly (readonly string[])[];
  requiresPatternItem: boolean;
}>;

export type LiveScenario = Readonly<{
  id: string;
  recalls: readonly LiveRecall[];
  sourceChats: readonly LiveSourceChat[];
}>;

export const liveScenario: LiveScenario = Object.freeze({
  id: "market-routine-v2",
  recalls: Object.freeze([
    Object.freeze({
      id: "tablecloth",
      prompt: "Use Personal Memory if relevant. What color tablecloth did I say I use at my Riverside Market booth?",
      requiredAnswerGroups: Object.freeze([Object.freeze(["teal"])]),
      requiresPatternItem: false
    }),
    Object.freeze({
      id: "team-lead",
      prompt: "Use Personal Memory if relevant. Who did I say is my team lead?",
      requiredAnswerGroups: Object.freeze([Object.freeze(["rachel"])]),
      requiresPatternItem: false
    }),
    Object.freeze({
      id: "dream-routine",
      prompt: "Use Personal Memory, including recurring patterns if relevant. When do I tend to begin preparing for weekend markets, and which three market routines support that?",
      requiredAnswerGroups: Object.freeze([
        Object.freeze(["before 7", "before seven", "early morning", "early in the morning", "6:"]),
        Object.freeze(["riverside"]),
        Object.freeze(["harbor"]),
        Object.freeze(["spring"])
      ]),
      requiresPatternItem: true
    })
  ]),
  sourceChats: Object.freeze([
    Object.freeze({
      id: "riverside",
      messages: Object.freeze([
        "A stable routine of mine: whenever I prepare for the Riverside Saturday Market, I count inventory at 6:20 a.m., before 7. I follow that early schedule every Riverside market day."
      ]),
      title: "Riverside market routine"
    }),
    Object.freeze({
      id: "harbor",
      messages: Object.freeze([
        "A stable routine of mine: whenever I prepare for the Harbor Sunday Market, I print price labels at 6:30 a.m., before 7. I follow that early schedule every Harbor market day."
      ]),
      title: "Harbor market routine"
    }),
    Object.freeze({
      id: "spring",
      messages: Object.freeze([
        "A stable routine of mine: whenever I prepare for the Spring Courtyard Market, I load the display crates at 6:40 a.m., before 7. I follow that early schedule every Spring market day."
      ]),
      title: "Spring market routine"
    }),
    Object.freeze({
      id: "booth-style",
      messages: Object.freeze([
        "Another stable detail: I use a teal tablecloth at my Riverside Market booth."
      ]),
      title: "Market booth style"
    }),
    Object.freeze({
      id: "business-name",
      messages: Object.freeze([
        "My small weekend-market business is called Cedar & Crumb."
      ]),
      title: "Weekend market business"
    }),
    Object.freeze({
      id: "signature-bake",
      messages: Object.freeze([
        "My signature savory bake for Cedar & Crumb is rosemary cheddar scones."
      ]),
      title: "Signature bake"
    }),
    Object.freeze({
      id: "catalog-goal",
      messages: Object.freeze([
        "My current business goal is to launch a Cedar & Crumb online catalog in May."
      ]),
      title: "Online catalog goal"
    }),
    Object.freeze({
      id: "camera",
      messages: Object.freeze([
        "I own a Sigma 24-70mm f/2.8 lens and use it for my product photography."
      ]),
      title: "Product photography"
    }),
    Object.freeze({
      id: "team",
      messages: Object.freeze([
        "Rachel is my team lead for the online catalog project."
      ]),
      title: "Catalog team"
    }),
    Object.freeze({
      id: "soccer",
      messages: Object.freeze([
        "My favorite soccer team is the Red Devils."
      ]),
      title: "Favorite soccer team"
    }),
    Object.freeze({
      id: "camera-body",
      messages: Object.freeze([
        "I own a Fujifilm X-T5 camera."
      ]),
      title: "Camera body"
    }),
    Object.freeze({
      id: "calendar-view",
      messages: Object.freeze([
        "My stable calendar-view preference is a weekly view."
      ]),
      title: "Calendar preference"
    }),
    Object.freeze({
      id: "recipe-units",
      messages: Object.freeze([
        "My stable unit preference for recipe measurements is metric."
      ]),
      title: "Recipe units"
    })
  ])
});

function normalizedAnswer(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en").replaceAll(/\s+/gu, " ").trim();
}

export function evaluateLiveRecall(
  recall: LiveRecall,
  answer: string
): Readonly<{ matchedGroups: number; passed: boolean; requiredGroups: number }> {
  const normalized = normalizedAnswer(answer);
  const matchedGroups = recall.requiredAnswerGroups.filter((group) =>
    group.some((candidate) => normalized.includes(normalizedAnswer(candidate)))).length;
  return Object.freeze({
    matchedGroups,
    passed: normalized.length > 0 && matchedGroups === recall.requiredAnswerGroups.length,
    requiredGroups: recall.requiredAnswerGroups.length
  });
}

export function validateLiveScenario(scenario: LiveScenario): LiveScenario {
  const sourceSendCount = scenario.sourceChats.reduce(
    (total, chat) => total + chat.messages.length,
    0
  );
  const identifiers = [
    ...scenario.sourceChats.map(({ id }) => id),
    ...scenario.recalls.map(({ id }) => id)
  ];
  if (scenario.id !== "market-routine-v2" ||
    scenario.sourceChats.length !== AIQSA_MEMORY_LIVE_SOURCE_CHAT_COUNT ||
    sourceSendCount !== AIQSA_MEMORY_LIVE_SOURCE_SEND_COUNT ||
    scenario.recalls.length !== AIQSA_MEMORY_LIVE_RECALL_SEND_COUNT ||
    new Set(identifiers).size !== identifiers.length ||
    scenario.sourceChats.some(({ id, messages, title }) =>
      !id.trim() || !title.trim() || messages.length < 1 ||
      messages.some((message) => !message.trim() || message.length > 2_000)) ||
    scenario.recalls.some(({ prompt, requiredAnswerGroups }) =>
      !prompt.trim() || prompt.length > 2_000 || requiredAnswerGroups.length < 1 ||
      requiredAnswerGroups.some((group) => group.length < 1 ||
        group.some((candidate) => !candidate.trim())))) {
    throw new Error("aiqsa_memory_live_scenario_invalid");
  }
  return scenario;
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function assertLiveBaseUrl(value: string, expectedPort: number): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("aiqsa_memory_live_base_url_invalid");
  }
  if (parsed.protocol !== "http:" || !loopbackHosts.has(parsed.hostname) ||
    parsed.port !== String(expectedPort) || expectedPort === 3000 ||
    parsed.username || parsed.password || parsed.pathname !== "/" ||
    parsed.search || parsed.hash) {
    throw new Error("aiqsa_memory_live_base_url_not_isolated");
  }
  return parsed;
}

export function assertLiveDatabaseUrl(value: string, expectedPort: number): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("aiqsa_memory_live_database_url_invalid");
  }
  const queryKeys = [...parsed.searchParams.keys()];
  if (parsed.protocol !== "postgresql:" || !loopbackHosts.has(parsed.hostname) ||
    parsed.username !== "aiqsa_benchmark" ||
    parsed.password !== "aiqsa-memory-benchmark-dev-password" ||
    parsed.pathname !== "/aiqsa_memory_benchmark" ||
    parsed.port !== String(expectedPort) || expectedPort === 5432 ||
    queryKeys.length !== 1 || queryKeys[0] !== "schema" ||
    parsed.searchParams.get("schema") !== "public" || parsed.hash) {
    throw new Error("aiqsa_memory_live_database_url_not_isolated");
  }
  return parsed;
}

export function resolveLiveOutputDirectory(
  benchmarkRoot: string,
  candidate: string
): string {
  const resultsRoot = resolve(benchmarkRoot, "results");
  const output = resolve(benchmarkRoot, candidate);
  if (output === resultsRoot || !output.startsWith(`${resultsRoot}${sep}`)) {
    throw new Error("aiqsa_memory_live_output_not_isolated");
  }
  return output;
}
