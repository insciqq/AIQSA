# CRITICAL_INVARIANTS

## Product Invariants

1. ADRs 0009-0011 and 0016 define the shipped conversation-first UI direction. Presentation and progressive disclosure may evolve only while preserving the complete product capability surface and explicit control ownership.
2. The default `aiqsa` theme remains dark. Shipped themes declare a dark or light scheme, and shared components must render through semantic, scheme-aware color recipes.
3. Provider, model, prompt, search, and parameter changes affect future messages only.
4. Existing message content with descendants is not edited in place; edits create branches.
5. Regeneration creates a sibling assistant branch through the model-run pipeline.
6. The visible thread is derived from `activeLeafMessageId`.
7. Streaming assistant messages have explicit status: `queued`, `streaming`, `complete`, `cancelled`, or `error`.
8. Usage and cost are tracked from final provider usage events, not guessed from UI text length.
9. Model-run APIs keep normalized request, provider request preview, events, final response, and usage inspectable; the common Details UI is an inspection surface focused on Branch and Events, never a second editor for next-run drafts.
10. AIQSA is a QSA client, not an agent builder, plugin marketplace, visual workflow graph, or generic tool-constructor UI.
11. Search is selected as an explicit backend-catalog strategy.
12. Raw user request/response logs are not persisted locally by default.
13. OpenAI integration uses Responses API with background-capable, stored, manual context replay. Specific default model ids live in the backend catalog/env/provider notes, not in durable invariants.
14. Available providers, models, and search strategies are loaded from the backend catalog for the current user.
15. `Share (anonymously)` creates a sanitized immutable snapshot, not public access to a private live chat.
16. Uploaded attachments are private and are not exposed by public share snapshots.

## Agent Development Invariants

1. Keep changes small and terminal-verifiable.
2. Update docs when changing architecture, env, tests, workflows, or product behavior.
3. Keep `active_tasks/` and `done_tasks/` intact as harness state.
4. Keep `done_tasks/` as a permanent significant-completion journal; remove stale narrative from living docs instead.
5. Do not make routine UI verification depend on Playwright MCP.
6. Prefer deterministic mocks before real paid API calls.
7. Do not commit secrets, API keys, database URLs with passwords, or private operator notes.
8. Run app checks through Docker Compose.
9. Real provider smoke tests are allowed autonomously with current operator-provided `.env` keys only when small-context, low-token, and scoped to the provider functionality under test.
10. Add or update ADRs for durable architectural decisions.
11. Run `npm run docs:check` before final responses for docs/harness changes.
12. Local development data is disposable. Playwright and checks may reset or pollute the shared local Compose database and bucket; never apply that assumption to production or operator-designated persistent data.

## Backend Invariants

1. Provider SDK/API calls stay behind internal adapters.
2. Route handlers validate input before touching storage or provider APIs.
3. Auth/user ownership checks are required for private resources.
4. Upload handling validates size and type server-side.
5. Placeholder model prices must not become production billing truth without verification.
6. OpenAI integration uses Responses API as the first-class path.
7. OpenAI background mode has explicit run status, polling, recovery, and cancellation states.
8. Model-run request/response inspection is product-critical, but raw user content logs are session-only unless explicitly saved.
9. Backend entitlement checks are required before every model run, even when the frontend catalog already filtered unavailable models.
10. Share snapshots must strip raw provider payloads, private attachment URLs, API keys, internal run ids, and private user/group metadata.

## Frontend Invariants

1. The conversation and composer must remain primary at desktop widths. Workspace navigation stays usable, while Details remains fully accessible on demand and optionally pinnable instead of being a mandatory permanent column.
2. Keyboard shortcuts must not break text entry.
3. All critical controls need accessible labels or stable test anchors.
4. UI state and server data should not be mixed into one untestable object.
5. Provider identity remains legible through the grouped entitled model catalog and selected model; choosing a concrete model applies its provider atomically, with no provider-only action.
6. Model/search selectors must use the backend-filtered current-user catalog.
7. Theme selection is a local UI preference only; it must not affect server data, shared chat state, or cross-device user defaults.
8. Users select concrete models from the entitled catalog; provider labels may group and describe models but must not silently choose a remembered/default/first model.
9. At `sm` and wider with more than 32rem of viewport height, Reasoning effort is a direct composer control when catalog state is available. In narrower or short-height composition, exact Reasoning plus Model/Profile/Search state remains legible in the text-backed Run summary, entitled Fast/Balanced/Deep profiles remain directly switchable, and the complete Run setup stays one tap away in its responsive sheet whenever the composer is engaged. An empty idle compact composer may temporarily collapse those Run/profile/action regions only after recent deliberate direction-consistent scroll intent; Message remains visible, a completed Message tap or keyboard focus restores the controls without activating newly revealed controls, composition/error states force expansion, and an addressable Stop action remains visible during streaming. The composer control owner remains the single UI editor for disclosed next-run parameters, and Details contains no duplicate draft editor.
