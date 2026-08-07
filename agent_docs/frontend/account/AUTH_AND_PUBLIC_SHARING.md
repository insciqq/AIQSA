# FRONTEND AUTH AND PUBLIC SHARING

Owner: Account and Control Center UI maintainers
Scope: Authentication workspace, OAuth/account continuity, mutation states, responsive behavior, and public-share interaction contracts.
Read when: Changing login/onboarding/recovery UI, OAuth continuity, auth errors/loading, responsive auth behavior, or public-share viewing.
Code owners: Authentication and public-share components, routes, and client state.
Not owned here: Server auth/share authorization, Control Center resources, Settings/Assistants, or visual recipes.

## Authentication Workspace

### Structure and modes

- `/login` is one restrained auth workspace on the answer-paper canvas, not a marketing page or generic SaaS card. Each sign-in, access-request, invite, verification, reset-request, reset-completion, and request-result mode owns the sole `<h1>`, its primary action, and only relevant secondary routes.
- Active bearer-proof precedence is verification, then reset, then invite. A completed proof or explicit return to ordinary sign-in removes the consumed parameter with history replacement while preserving a safe internal destination. A genuinely new proof tuple may activate a new mode; unchanged props never resurrect a retired proof.
- Access request collects no password. Direct invite acceptance collects display name and a new password without displaying or asking for the token-bound email. Verification and reset completion collect a new password. Successful invite acceptance enters the workspace through the returned session; verification may finish active or pending; reset success returns to sign-in.
- Sign-in and every password-establishing form provides a visible Show/Hide password control. Toggling preserves the value, mode changes conceal it, and autocomplete distinguishes current from new passwords.
- The normal workspace never exposes bootstrap tokens, recovery hints, fake open-registration promises, raw OAuth material, or server policy controls.

### OAuth and account continuity

- Normal sign-in shows Google and/or Yandex only when the server advertises that provider. OAuth preserves the same sanitized internal destination and is absent from invite, verification, and reset modes.
- Privacy-safe OAuth cancellation, provider failure, pending/denied state, or binding conflict returns to clean login UI with readable feedback. Raw provider errors, codes, tokens, and profile data never render.
- Password and OAuth identities for the same accepted normalized email resolve to the same account data and entitlements. The frontend never presents OAuth linking as a second workspace or parallel account.

### Mutation, error, and responsive behavior

- A pending mutation disables its fields, visibility toggle, submit, and mode navigation, and shows one specific working label. Duplicate submission and mode replacement are impossible until it settles.
- Local validation and backend/network failures use readable announced alerts while retaining stable backend codes in parentheses. Attributable credential fields are marked invalid and associated with the alert. Retryable failures preserve the active mode and applicable entered values.
- Access-request and reset-request success language stays enumeration-safe. It never claims that an account exists or mail was sent unless the server contract explicitly says so.
- Initial sign-in leaves focus under browser/user control. Deliberate mode changes and settled operations move focus to the next useful control. Mutation feedback remains in document flow near the owning action.
- At 390x844, short desktop, and landscape mobile, the workspace stays top-aligned, safe-area aware, vertically scrollable under the software keyboard, and free of page-level horizontal overflow. Primary and back actions remain reachable; semantic palette tokens preserve autofill contrast.

## Public Share

- `/s/[shareToken]` is anonymous and resolves the hashed token server-side. Missing, revoked, expired, and invalid links all render the same `Shared snapshot unavailable` result without owner, token, or reason detail.
- The page identifies AIQSA, `Shared conversation`, and `Read-only snapshot`; it renders one title and explains that the immutable branch neither updates nor changes the original. Blank titles safely become `Shared chat`.
- User turns keep the private thread's compact question treatment; answers remain full-measure document flow. The page has no provider/model metadata, message actions, composer, Details, branch controls, share management, authenticated-shell dependency, or promotional call to action.
- Rendering consumes only sanitized user/assistant text plus sanitizer-produced attachment-omission text. It never reads private message/share/run/object identifiers, raw provider material, secrets, or user/group data. Shared Markdown keeps safe links/citations and inert raw HTML/unsafe URLs.
- A branch containing hosted-answer Gemini grounded live-only provenance cannot be shared. The UI explains the limitation and never publishes a neutral storage placeholder as an answer; normalized query-only Gemini Search evidence follows the ordinary client-Search projection instead.
- Empty snapshots and empty turns use neutral deliberate fallbacks. Long prose, titles, links, tables, and code stay within the page; only table/code owners may scroll horizontally.
