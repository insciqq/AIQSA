---
paths:
  - "lib/server/memoryNote/**"
  - "lib/server/chatSearch/**"
  - "lib/server/background/chatSearchPasses.ts"
  - "lib/server/tools/{manageMemory,pastChats}.ts"
  - "lib/contracts/{memoryNote,pastChats}.ts"
  - "features/settings-v2/MemoryNoteSettingsV2.tsx"
  - "features/answer-outputs-v2/PastChatSourcesV2.tsx"
---
# Memory

Memory is the user's memory note and past-chat search; they replaced Personal Memory in v0.5.0 (root `AGENTS.md`). The note: `lib/server/memoryNote/`, its tool `lib/server/tools/manageMemory.ts`. Search: `lib/server/chatSearch/`, its tools `lib/server/tools/pastChats.ts`. Wire shapes: `lib/contracts/memoryNote.ts`, `lib/contracts/pastChats.ts`.

Why the old design went (production evidence, 2026-11-22): thousands of extraction calls left a few dozen automatic facts on two installations, among them contradicting preferences, one-off task details, health details and colleagues' addresses, all injected into every turn; no user ever edited one. What users saved themselves were answer rules, procedures, project context, glossaries and links, and the search they used was almost always for earlier work chats. Background learning, a fact store or a remember classifier comes back only by a new operator decision.

## The note

- One plain text per user, edited in Settings › Memory and included in every ordinary personal turn after the personal Instructions. Admission freezes it like the Instructions, so a change applies from the next message. The note is the single home of standing answer rules (operator decision 2026-11-22); Instruction presets stay for those who use them.
- The user changes it directly. The agent changes it only through `manage_memory`, and only for the user's own message in the current turn: a tool result, page, file, Skill, another agent's message or a turn the server wrote (a wake-up, a sign-in request, a scheduled prompt) never authorizes a change; the continuation after an MCP Allow has the authority of the turn whose call the user allowed, so it is the user's turn only after an Allow of the user's own (`storedUserRequest` in `lib/server/runs/turnProvenance.ts`). The run's frozen tool list and the note's service both check this (`lib/server/memoryNote/agentMemoryNote.ts`).
- Operator decisions 2026-11-22: an explicit request to remember, change or forget something, or to do something always or from now on, is applied at once and the answer shows a change card with Undo; a lasting rule or context the user states without asking to keep it is only offered, and nothing is written until the user accepts the card. With suggestions off the agent never offers; explicit requests still work.
- "Remember" and "change my default instruction" are different things (operator decision 2026-11-22): `manage_instructions` serves only requests that name the Instructions or the preset; "remember", "always" and "from now on" go to the note.
- What belongs there: who the user is, how to answer, projects, terms and links. One-off details need nothing. Health, family, finances, beliefs and similar personal matters go in only on the user's explicit request; that is a prompt rule (`lib/server/memoryNote/prompt.ts`), not a classifier. A contradiction replaces its line; a full note is condensed or the user is asked, never cut silently.
- Credentials are refused, never redacted, whoever writes, so the note always holds what its owner saw; they belong in Secrets (`lib/server/memoryNote/secrets.ts`).
- Nothing is learned in the background: Memory makes no model call outside the answer itself.
- Only a committed card confirms a change. An offer accepted later must still apply to the note as it is then.

## Where Memory applies

- The three switches (`memorySwitchesSchema`) carry the old ones one to one (decision 2026-11-22): `memoryEnabled` is the master (off: no note, no search, no offers; the text stays), `pastChatSearchEnabled` and `memorySuggestionsEnabled`.
- Interactive personal chats and Telegram get the note, search and `manage_memory`. Assistant chats get the note but never `manage_memory`, since the author's instructions steer them, and search only in the user's own Assistant (`lib/server/runs/runPreparation.ts`).
- A scheduled task with its Memory switch on reads the note and may search, and never writes; its own chat stays unsearchable.
- Discord, sub-agents, Temporary and Excluded chats get neither. Imported chats, their continuations and branch copies are Excluded and cannot be resumed (operator decision 2026-10-04); a database check in `prisma/migrations/20261005121500_chat_import_source/` enforces this for every writer.

## Past-chat search

- One rule decides what is searchable, shared by the indexer, the tools and the sources under answers (`lib/server/chatSearch/eligibility.ts`): the owner's own ordinary chats, active branch only (a passage left on an abandoned branch is skipped before search ranks or reads anything, until the indexer drops it), without the turns holding a message the old Memory kept out of history search, carried once into `ChatSearchExcludedMessage` (`prisma/migrations/20261122142000_chat_search_carried_exclusions/migration.sql`): a branch copy keeps them out, and only Resume, whose disclosure says the whole chat becomes searchable, lets them in. Vectors are made only for an active account with Memory and past-chat search on; other owners' chats keep words only, searchable once the switches are on again (`lib/server/chatSearch/index/ownerEmbedding.ts`; integrator decision 2026-11-23: nothing leaves the installation while they are off, and the switch copy promises nothing about turns written meanwhile). A chat is known to search by its search title (`chatSearchTitle` in `lib/server/chatSearch/index/passages.ts`): a title the server made from the first message is not shown when that message is kept out, and shows its screened first line when it held a secret; a title the owner set stays. A chat that is deleted, excluded or made Temporary leaves at once: its passages go in the transaction that changes it, and other answers' sources drop it when they load (`lib/server/chats/pastChatSources.ts`). Turning a switch off keeps the passages and stops the searches.
- What an answer read from another chat stays in its own chat's records, as an answer quoting it does: its call results, old `memory_search` results included, are not scrubbed when the source chat is deleted or leaves search (decision 2026-11-22; v0.5.0 drops the old per-search receipts that scrubbed them). Secrets never reach them, because text is redacted before it is stored.
- Secrets are redacted before text is stored or embedded, and from every query before it reaches SQL, the embedding model or the reranker (`agent_docs/SECURITY.md`).
- A turn is indexed right after its answer settles, and the rest of the chat stays searchable meanwhile; the old index lost whole chats while they waited for a quiet window. Tool events are not indexed: they filled most of the old index and were never returned.
- Words always work: exact-word search needs no model, and it behaves the same in every language, because terms come only from PostgreSQL's `simple` parser and no vocabulary, stemming or language rule decides anything (`lib/server/chatSearch/search/query.ts`). Meaning search uses only the administrator's embedding model (`agent_docs/PROVIDERS.md`); one not set, unusable, failing or late leaves word results marked partial, never another model. A failing reranker keeps the fused order. Results come in relevance order, never re-sorted by date, and an identifier the query names exactly comes first (`lib/server/chatSearch/search/`). No language model is called.
- Each answer has a bounded number of searches and reads (`PAST_CHATS_CALL_LIMITS` in `lib/server/tools/pastChats.ts`), and every result names its chat, title, date and message, so the agent can read on with `read_past_chat`.
- Left out on purpose (decisions 2026-11-22): a generative reranker, index generations and a per-search receipt table; the sources under an answer come from its own call results. Exact vector search filtered by owner is enough at the measured sizes (thousands of turns per user), so there is no approximate index.
- Quality is measured by the scenario suite (`agent_docs/TESTING.md`); change ranking only against it.

## The old Memory's data

- v0.5.0 carried it once (`agent_docs/PERSISTENCE.md`): saved facts became the note; automatic facts, saved facts the old prompts withheld, those of owners whose saved-secret cleanup had not finished, and lines past the limit wait as suggestions the owner keeps or removes in Settings › Memory. Nothing was dropped silently.
- Messages it kept out of history search (before a Resume, a history reset or a deletion of all Memory, inside a pause, forgotten sources) stay out of past-chat search.
- Accepted (reported to the operator 2026-11-22): answers recorded before the upgrade lose their Memory and Past chats source lists, remember receipts and `/memory` cards; their text, web sources and files stay. Recorded `memory_search` steps keep a plain label.
- Usage keeps the purposes `memory_indexing` and `memory_retrieval`, so usage history stays continuous; the interface calls them past-chat search.
