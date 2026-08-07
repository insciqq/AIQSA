# FRONTEND RUN RECEIPT AND DETAILS

Owner: Chat interaction maintainers
Scope: Run receipt, inspection entry points, Details pane behavior, pinning, overlays, tabs, and responsive access.
Read when: Changing run receipts, evidence/usage affordances, Details opening/pinning, inspection tabs, overlays, or narrow-screen Details access.
Code owners: Run receipt, inspection, and Details-pane components and state.
Not owned here: Composer input, navigation, next-run selectors, provider persistence, or visual recipes.

## Run receipt

- An Assistant answer keeps the normal document presentation and gains one compact snapshot-bound identity line — small avatar plus name from the accepted revision — above the answer body; freeform answers remain plain `Answer`. Name and avatar come from the accepted revision, never the current Assistants entry, so later renames, archives, or access changes cannot alter historical rows. There is no permanent avatar gutter or chat-bubble treatment, and public anonymous snapshots retain their neutral Answer presentation without Assistant identity.

- Every non-streaming assistant answer can explicitly reveal one quiet compact evidence block through its own `More` → `Show run details`; hover, focus, and message tap reveal only the shared action dock and never mount the receipt. The block is derived only from that message's status, snapshot-bound Assistant identity with its exact revision when the accepted run used one, stored provider/model identity, bounded search/citation/artifact summary, message-bound warnings, and its message-bound persisted `runUsage` projection. Each completed answer therefore retains its own provider-reported normalized total after later runs and reloads; absent or zero usage produces no token fact. Search and citation facts expand their existing details inside that block instead of rendering as separate stacked summaries. It does not reconstruct historical Assistant, Search, or other facts from the current composer/catalog defaults and adds no fetch, store, API, or inspection tab.
- Search, Tools, Citations, and Reasoning segments open the existing disclosure on their originating answer when that disclosure is rendered. A hidden evidence segment or status/model/usage/context/warning segment opens Details → Events only when the same answer owns the exact currently loaded persisted run and that run has real events. Otherwise the segment remains factual noninteractive text; a historical answer must never open another answer's Events. The receipt is absent while the answer streams.
- Hosted-answer native Gemini grounded output is a deliberate live-only exception. The current stream renders the answer only after a non-empty validated `grounding_display`, with safe transient citations and the exact Search Suggestions inside an isolated ShadowRoot. The component never sends provider markup through `MarkdownMessage`, an iframe, or ordinary `dangerouslySetInnerHTML` in the document tree. On navigation/reload the thread shows only the backend's neutral grounded placeholder/provenance; it does not reconstruct answer text, Suggestions, Links, or citation detail from current state. Query-only Gemini client Search never renders that markup and appears through the ordinary normalized Search disclosure.

## Details pane

- new sessions start closed; explicit Pin is the only open presentation persisted across reloads, and it restores only at the `>=1440px` eligibility breakpoint;
- run start/completion and fork activation never mutate Details presentation or steal focus;
- the full Details surface shows exactly Branch and Events, in that order;
- Details tabs implement one controlled roving tab stop with Arrow/Home/End navigation, visible focus, wraparound, and stable tab/panel relationships;
- the Details header shows readable active/error/run status and names the mode only when it is `Pinned beside chat`; the ordinary overlay needs no redundant subtitle, and errors are wrapped text rather than icon-only chips;
- Close removes Details; Overlay does not alter the grid; Pin adds the wide-only 360px column; Unpin keeps Details open as an overlay;
- the `Branch tree` item in `Conversation actions` opens Details on Branch at every viewport;
- readable live run activity opens Details on Events; no activity control is rendered while idle or settled;
- Run setup is the only UI editor for temperature and max-output drafts. Closing Details has no parameter-flush side effect because Details owns no drafts;
- overlay Details uses one shared responsive state and selector on desktop/mobile, with modal focus/background behavior only while overlaid;
- Details never presents next-run draft values as historical request inspection. Historical/deep request inspection stays in Events and model-run APIs; a future immutable Request tab requires a separate persisted data contract.
- Details delegates next-run editing to the single Run setup owned by
  [Run controls](RUN_CONTROLS.md); it does not mirror that inventory or its
  capability gating.
- Events is a chronological digest with readable stage names, ordinal cues, semantic status glyphs, and plain-language detail. Provider/search/tool/citation/reasoning/token/usage noise is aggregated in place at each category's first occurrence, so later counts/details update without moving rows. Warning, long failure detail, cancellation, and successful completion remain distinct and fully wrapped; raw token deltas and internal assistant ids never render.
- empty Events states explain that events appear during a run and that a run never opens Details automatically;
- Branch renders readable Q/A role labels and plaintext multiline excerpts: stored Markdown remains unchanged, linear/current-path rows are static, depth increases only below actual fork points, only true alternate versions expose the user-facing `Open version` action, and the active leaf is named without exposing message ids;
- root-level siblings created by editing the first message are true forks: the version/message counts include them with correct singular/plural wording, exactly one leaf is `Current`, and the single-version explainer appears only for a genuinely linear conversation. Activating `Open version` checks out that branch's deepest leaf so the whole alternate conversation renders and the composer targets its leaf; checkout never auto-opens or closes Details;
- Branch empty/linear guidance explains that edit, regenerate, and Branch from here create branches;
- thread messages show one calm, direct, default-collapsed Search disclosure below an answer whenever hosted or client Search evidence exists, during execution and after reload. It is independent of `Show tool activity`; expansion gives friendly source/status/count facts, generated queries, safe normalized sources/citations, and bounded provider-reported search/open/find operations without technical routing. Historical/provider omission says detail is unavailable rather than showing zero, and failed/cancelled/partial execution stays explicit;
- when `Show tool activity` is on, each assistant run with observed non-Search client-executed calls shows a separate default-collapsed summary during execution and after reload. Expansion groups calls by model round, marks same-round batches as parallel, and gives each call a disclosure with MCP server/tool identity, live or terminal state, duration, safe account/credential-source metadata, and bounded redacted argument/result previews. Search capability calls are excluded from this generic summary so the direct Search disclosure is never duplicated. No raw executable configuration, endpoint, secret, opaque invocation id, or unrestricted payload is rendered;
- thread messages show optional collapsed citation disclosures when provider/search citation artifacts exist, including direct Perplexity answers and historical Perplexity search runs; links remain safe and long titles, URLs, and snippets stay contained;
- thread messages show a compact context-window hint before the answer when the backend emits a `context_truncated` artifact for dropped prior turns;
- Events shows context-window truncation as a warning row with dropped message/token estimates;
- empty citation/reasoning artifact disclosures state that no text was captured only after the user expands them;
- Branch checkout rows are disabled while a response is streaming and expose a visible stop/finish-first explanation.
- reasoning/thinking artifacts can be toggled visible from the composer control bar; provider summary arrays render as readable text blocks and empty fragments are not counted when text blocks exist.
