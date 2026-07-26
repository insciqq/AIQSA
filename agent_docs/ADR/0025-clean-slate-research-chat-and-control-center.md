# ADR 0025: Research Chat And Control Center Replace The View Layer In Place

Status: Accepted
Amends: 0009-conversation-first-ui-revamp, 0010-neutral-light-theme, 0016-responsive-composer-disclosure, 0018-intent-gated-mobile-reading-mode

## Context

AIQSA's routes, authentication, provider control plane, run pipeline, stores, client-safe contracts, and multi-user capabilities are already the product foundation. The remaining problem is not missing visual polish. The shipped presentation grew through successive local improvements and still makes first use, ordinary research, and administrator setup feel like operating an internal console. Its component hierarchy, density recipes, and responsive choreography are therefore poor constraints for another incremental restyle.

The operator has requested a clean-slate UI/UX result comparable in clarity and ease to leading conversation products without cloning their assets, layouts, or product functions. The ordinary single-administrator path must be immediately understandable, while team governance and low-frequency operational controls remain complete without dominating first use. Concept work must use actual AIQSA destinations and states rather than invented navigation, metrics, or capabilities.

Clean slate applies to the view layer. It does not authorize a second application, a second runtime, new API ownership, duplicated client stores, or a product/backend rewrite.

## Decision

### Rewrite boundary

1. AIQSA replaces the authenticated presentation in place around two product surfaces:
   - **Research Chat** at the existing `/` route for Question -> Search -> Answer work;
   - **Control Center** at the existing `/admin` route for administrator-owned installation and team configuration.
2. Existing login, public-share, API, health, and admin routes keep their paths and authorization behavior. Login and public share adopt the same visual foundation when their presentation is replaced, but they do not become extra authenticated destinations.
3. The rewrite preserves the current Next.js runtime, server/client boundaries, stores, actions, run orchestration, contracts, persistence identities, entitlements, provider adapters, safe Markdown renderer, and all currently supported capabilities and observable states. Existing presentation components and CSS recipes are migration input, not compatibility surfaces; they may be replaced completely.
4. The existing shell/view-model boundary remains the initial strangler seam. New Research Chat views consume the established `session`, `workspace`, `thread`, `composer`, `details`, `settings`, and `overlays` slices instead of creating a parallel state graph. Control Center views likewise consume the existing admin controllers and client contracts.
5. There is no `v2` route tree, second Next.js application, alternate runtime, duplicate API namespace, parallel provider/admin client, duplicate draft store, or long-lived old/new UI switch. Temporary view modules may coexist only while an in-place slice is being brought to parity.

### Product and information architecture

6. Research Chat is conversation-first. The conversation and composer own the primary hierarchy; workspace navigation, run evidence, settings, and inspection support that loop without becoming permanent competing dashboards.
7. Control Center exposes only the real administrator destinations already owned by the product:
   - `Providers` and `Usage` under **Personal**;
   - `Users`, `Groups`, `Model access`, `Invites`, and `Access rules` under **Team**;
   - `MCP servers`, `Email delivery`, and `Safety` under **Advanced**.
8. **Personal**, **Team**, and **Advanced** are navigation and progressive-disclosure groups, not plans, editions, roles, licenses, or entitlement boundaries. They never imply payment, upgrade prompts, capability removal, or a different backend. Search and direct links may reach every authorized destination regardless of its disclosure group.
   Their initial disclosure comes from a secret-free `/api/admin` projection of actual installation state, not group names or browser guesses. Another user, invite/rule history, enabled group access, group MCP access, or group credential assignment expands Team; MCP or SMTP configuration expands Advanced. Unknown state fails open, and the active direct-link destination remains visible. This projection does not eager-load the independent provider, MCP, or email control-plane resources.
9. `Run profiles` remains a compact editor inside `Providers` under ADR 0024; it is not an invented top-level destination. Overview figures, setup progress, provider revisions, diagnostics, and validation evidence are contextual content inside their owning destination, not dashboard destinations of their own.
10. Control Center navigation places Personal first, and opening Providers starts with its Quick setup surface. The existing `/admin` default Users section and all `section` aliases remain stable; the entitled Account entry may use the existing Providers alias so ordinary administrator setup starts in Personal without redefining bare `/admin`. A supported provider's guided path is provider -> key -> `Test & save` -> ready model/profile access for the acting administrator, orchestrating the existing test, persistence, activation, and direct-administrator-grant operations without weakening their server-side validation or atomicity. It does not require the administrator to create a group or assign themselves to one. Credential rotation, multiple credentials, group assignments, revisions, exact diagnostics, and recovery controls remain available through explicit advanced disclosure in their existing owning destination.

### Visual direction and themes

11. First use is light-first and neutral. When no persisted theme preference exists, AIQSA starts with theme id `neutral`. The visual foundation uses a quiet neutral conversation canvas, restrained separators and elevation, readable near-black text, one interaction accent, and semantic color only where it communicates status or risk. It does not use decorative gradients, a grid of interchangeable cards, or terminal/trading-console framing.
12. All five persisted theme ids remain valid and stable: `neutral`, `aiqsa`, `graphite`, `verdant`, and `classic-dark`. Existing preferences are honored without migration or silent reset. Changing the no-preference default does not rewrite an existing user's choice.
13. Dark mode is parity, not a later enhancement. Every Research Chat, Control Center, auth, share, overlay, code, math, loading, empty, warning, error, disabled, and selected state delivered in `neutral` must be complete and visually coherent in all four dark palettes. Scheme-aware browser chrome, syntax rendering, scrims, shadows, and semantic tokens remain mandatory.
14. Familiar conversation-product clarity is a quality reference, not a clone target. AIQSA's identity comes from evidence-backed QSA runs, provider transparency, and disciplined content rather than copied brand chrome or decorative pipeline graphics.

### Adaptive Research Chat layout

15. Layout responds to available space and input conditions, not width alone:
   - at `1024px` and wider, Research Chat has a desktop workspace rail and the conversation canvas;
   - from `1024px` through `1439px`, Details opens as an overlay and does not permanently reduce reading width;
   - at `1440px` and wider, the user may optionally pin Details while preserving a viable conversation measure;
   - below `1024px`, workspace navigation uses a drawer and secondary configuration or inspection uses an appropriate drawer or sheet.
16. Height, coarse versus fine pointer, the visual viewport, software-keyboard occlusion, safe-area insets, and available `dvh` participate in disclosure decisions. Compact presentation must not depend on browser chrome staying fixed, create page-level horizontal overflow, or place a primary action behind a software keyboard or device inset.
17. Workspace, New chat, current location, account, settings, share, and Details remain directly discoverable at every supported size. Responsive relocation may change their chrome but not their owner, availability, or blank-chat semantics.

### Resting composer and next-run controls

18. The resting composer is one coherent surface with this visible action hierarchy: **Attach**, **Tools**, a clearly labeled **Message** input, one textual **Run summary**, and **Send** or addressable **Stop**. Controls may reflow for space, but they do not become an unexplained icon rail.
19. Without opening setup, the Run summary exposes the exact selected **Model**, derived **Profile** (`Fast`, `Balanced`, `Deep`, `Custom`, or unavailable as applicable), **Reasoning** mode/effort or unsupported state, and **Search** strategy or `Off`. Text, not color or an approximate meter, carries those values.
20. One activation of the Run summary opens the complete Run setup using the same composer owner and draft. It provides Model, Profile, Reasoning, Search, Prompt, generation limits, response behavior, display preferences, sound, context/usage, and other currently supported next-run controls. It does not create a second form, store, default, or ownership path.
21. Concrete model selection, provider grouping, profile application, reasoning support, entitlement filtering, per-model draft restore/clamping, attachments, MCP tool enablement, edit/regenerate branching, numeric flush, Enter/Shift+Enter/IME behavior, autosave, Send/Stop, and concurrent-chat runs retain their current contracts. Responsive disclosure never substitutes an inferred provider choice or hidden default for an exact model selection.

### Run receipt and Details

22. AIQSA's single signature presentation element is the **Run receipt** attached to an assistant response. It is a compact, calm account of what the run actually did, backed only by existing persisted run bindings, safe execution snapshots, provider-reported usage, citations, tool activity, events, and terminal state.
23. A Run receipt may show evidence such as the concrete provider/model display snapshot, actual search/tool activity, citation count, terminal status, and provider-reported usage when that evidence exists. It omits unavailable fields or labels them unavailable; it never invents a historical Profile, estimates cost, infers that search ran from the selected strategy, or converts a draft setting into completed-run evidence. Live progress remains clearly distinct from immutable completed evidence.
24. Run receipt is a view projection, not a new database resource, API, event type, or client. Its disclosure may lead to the existing citation/tool artifacts or Events inspection without duplicating those sources.
25. Details contains exactly two destinations: **Branch** and **Events**. It remains an inspection surface, not a next-run editor. No `API params`, `Request`, settings, receipt, or draft tab is added. Branch retains true-fork navigation and checkout; Events retains chronological run evidence. ADR 0011 continues to own this boundary.

### Deferred accessibility, performance, and content gates

26. WCAG conformance and dedicated accessibility implementation are explicitly outside the current revamp scope by operator decision. The rewrite does not add accessibility audits, screen-reader/forced-colors remediation, keyboard-only parity work, dedicated accessibility tests, or accessibility-based cutover gates. Existing native semantics and already-working interaction behavior may remain when reused, but preserving or expanding them is not a condition for completing a presentation slice. A future accessibility phase requires a new active task and may amend this decision.
27. Responsive acceptance still includes representative narrow portrait, short landscape, tablet, desktop, and wide pinned-Details states with real long titles, model names, code, tables, errors, loading, streaming, and software-keyboard conditions. No primary touch workflow may depend on hover.
28. Performance parity requires that the new view not duplicate API requests, subscriptions, streaming consumers, Markdown work, or store ownership. Nonessential heavy panels load on demand; opening drawers or changing presentation must not remount an active run, lose drafts, disturb established scroll ownership, or block streaming updates. Each slice records a before/after production-build and representative interaction baseline; a material regression requires explicit review rather than being hidden by the visual rewrite.
29. Content is part of the gate. Labels name the action or user-recognizable object in sentence case; the same action name is used through trigger, progress, success, and failure. Empty and error states explain the next available action. Production concepts and fixtures use real routes, destinations, capabilities, and state vocabulary. Invented analytics, plan language, fake collaboration features, vague technical copy, and decorative status claims are prohibited.

### In-place transition and deletion

30. The rewrite uses an in-place strangler sequence:
   1. inventory the existing capability/state and its tests;
   2. establish the shared adaptive and theme primitives;
   3. replace one presentation slice through the existing controller or view contract;
   4. verify behavioral, responsive, theme, content, and performance parity;
   5. switch the existing route/composition owner to the replacement;
   6. delete the superseded component, style, adapter glue, and obsolete presentation tests.
31. Temporary parallel presentation code is bounded migration scaffolding. Once a slice reaches parity, the legacy view is deleted instead of retained as a fallback or alternate mode. Full completion requires removal of the old Research Chat and Control Center presentation trees and stale CSS after all owners have moved.
32. Git history or a dedicated backup branch may preserve the former implementation; the running product does not carry it. Capability parity is judged against contracts and observable behavior, not DOM structure or visual resemblance to the legacy UI.

## Amendments To Earlier Decisions

### ADR 0009

- This ADR replaces ADR 0009's opening `dark-first` default with light-first `neutral` first use while retaining complete dark-theme parity.
- ADR 0009 decision 2's general conversation-first and on-demand Details ownership remains, but its presentation is refined by the `1024px` desktop rail and `1440px` optional pin thresholds above.
- ADR 0009 decision 3's requirement that Model and Search be legible remains, but the old permanent composer composition is replaced by the exact Run summary plus one-activation full setup.
- ADR 0009 decision 6 no longer requires continuity with the shipped view hierarchy, density recipes, or typography placement. Its restrained hierarchy, semantic status, safe rendering, and theme registry remain; its accessibility-specific acceptance clauses are deferred by decision 26 above.
- ADR 0009 decisions 1, 4, 5, and 7 remain fully accepted: conversation focus, capability parity, selective power-user density, and no clone target are not reopened.

### ADR 0010

- This ADR amends ADR 0010 decision 4 and its consequence that first-run appearance does not change: `neutral`, not `aiqsa`, is now the fallback only when no preference exists.
- All five ids and every persisted preference remain stable. ADR 0010's scheme metadata, semantic surfaces, Classic palette definitions, and cross-theme capability requirements remain accepted; formal contrast conformance is deferred by decision 26 above.

### ADR 0016

- This ADR replaces ADR 0016 decisions 2 and 3's width/height-specific split between permanent desktop controls and compact Run summary with one adaptive resting-composer hierarchy at all sizes.
- It replaces decision 5's phone-specific setup ownership with the same one-activation Run setup disclosure wherever space or input mode calls for it, and replaces decision 7 plus the 2026-07-19 direct-profile-footer addendum's required footer composition. Profiles remain one tap away and exactly legible in the resting Run summary rather than occupying a mandatory compact footer.
- ADR 0016 decision 1 remains controlling: state, persistence, entitlement filtering, action ownership, and next-run semantics do not change. Its software-keyboard and coarse-pointer layout outcomes remain, while its accessibility-specific acceptance clauses are deferred by decision 26 above.

### ADR 0018

- This ADR replaces ADR 0018 decision 1's fixed desktop/mobile rail composition with the adaptive rail/drawer rules above while preserving clear current-page context and direct access to Workspace, New chat, Copy thread, and Branch tree.
- ADR 0018 decisions 2 through 7 and their 48px scroll-intent addendum are no longer required presentation behavior. The clean-slate resting composer is compact without depending on scroll-triggered collapse or gesture-direction accumulation.
- The direct compact New chat addendum's placement recipe is replaced, but its top-level blank-workspace ownership, first-send persistence, keyed drafts, background-run independence, readiness guard, touch target, and containment requirements remain.
- Message availability, an independently addressable Stop action, and protection from programmatic-scroll surprises remain mandatory outcomes; accessibility-specific acceptance clauses are deferred by decision 26 above.

ADR 0011 is not amended. Concrete models remain the selectable identity; providers remain grouping context; next-run controls retain one composer owner; the exact Model/Profile/Reasoning/Search state remains legible; and Details remains Branch/Events inspection only.

## Consequences

- AIQSA can look and behave like a completely new product surface without forking its runtime or reopening provider, run, authorization, persistence, or entitlement architecture.
- New users receive a neutral light workspace, while all existing theme choices and full dark behavior remain intact.
- Single-administrator provider setup becomes the first Control Center story; team governance and operational depth remain complete but deliberately disclosed.
- The Run receipt gives AIQSA a product-specific visual signature without inventing data or weakening the separation between next-run controls and historical evidence.
- Migration carries an explicit deletion obligation: parity removes the legacy view instead of making two frontends permanent.
