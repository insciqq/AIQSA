# CRITICAL_INVARIANTS

## Product Invariants

1. ADRs 0025 and 0028 define the shipped Research Chat and task-first Control Center presentation while retaining the capability-preservation and explicit-control-ownership requirements of ADRs 0009 and 0011. The existing routes have one presentation tree and one state owner; parallel classic/new renderers and legacy visual-token aliases must not return. WCAG conformance and dedicated accessibility work remain explicitly deferred.
2. First use defaults to the light `neutral` theme. Existing `aiqsa`, `graphite`, `verdant`, `classic-dark`, and `neutral` theme IDs and stored preferences remain valid; the appended light `paper` id is equally stable. Every theme must render the same semantic hierarchy with declared light/dark scheme metadata and complete dark-mode parity.
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
13. Native OpenAI integration uses Responses API with background-capable, stored, manual context replay. Administrator-managed compatible endpoints select Responses or Chat Completions explicitly; deployment IDs and upstream model names are not durable invariants.
14. Available providers, models, and search strategies are loaded from the backend catalog for the current user.
15. `Share (anonymously)` creates a sanitized immutable snapshot, not public access to a private live chat.
16. Uploaded attachments are private and are not exposed by public share snapshots.

## Agent Development Invariants

1. Keep changes small and terminal-verifiable.
2. Update docs when changing architecture, env, tests, workflows, or product behavior.
3. Keep `active_tasks/` and `done_tasks/` intact as harness state.
4. Keep `done_tasks/` as a permanent significant-completion journal; remove stale narrative from living docs instead.
5. Keep routine UI verification in repository-owned Playwright CLI tests.
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
11. Provider entitlement and credential selection are independent. Credential precedence is direct user, then one unambiguous active-group assignment, then an allowed default; once a tier selects a credential, an unusable selection fails closed without fallback.
12. Every bootstrapped or adopted installation has exactly one lifecycle-immutable built-in `full_access` group. Its explicit active members inherit all current and future provider/model/search and MCP entitlements, but never inherit provider key selection or MCP personal-slot secrets from that wildcard. A legacy ordinary group with the reserved name is preserved under a collision-safe custom name, never promoted with its members or policy references. A just-migrated empty database may remain group-free only until first installation bootstrap.

## Frontend Invariants

1. The conversation and composer must remain primary at desktop widths. Workspace navigation stays usable, while Details remains available on demand and optionally pinnable instead of being a mandatory permanent column.
2. Keyboard shortcuts must not break text entry.
3. All critical controls need clear visible labels or stable test anchors.
4. UI state and server data should not be mixed into one untestable object.
5. Provider identity remains legible through the grouped entitled model catalog and selected model; choosing a concrete model applies its provider atomically, with no provider-only action.
6. Model/search selectors must use the backend-filtered current-user catalog.
7. Theme selection is a local UI preference only; it must not affect server data, shared chat state, or cross-device user defaults.
8. Users select concrete models from the entitled catalog; provider labels may group and describe models but must not silently choose a remembered/default/first model.
9. Composer composition adapts to available inline/block space and input capability instead of a device-name breakpoint. Its resting surface keeps attachment/tools, Message, direct Model/configured Profile/Search controls, More, Send, and an addressable Stop during streaming; the complete Run setup including Reasoning stays one More action away. Direct controls wrap instead of gaining a second compact owner. The composer control owner remains the single UI editor for next-run parameters, while Details contains Branch and Events inspection only.
