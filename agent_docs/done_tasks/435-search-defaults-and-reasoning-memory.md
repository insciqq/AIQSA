# 435-search-defaults-and-reasoning-memory

Status: done
Completed: 2026-07-31
Depends on: none

## Goal

Add inherited admin Search defaults, durable user Search preferences, and per-model direct Reasoning controls

## Scope

- Add one versioned installation Search policy whose ordered zero-to-three-option plan is a recommendation and never an entitlement grant.
- Distinguish inherited Search preference from an explicit personal plan and explicit personal Off while preserving existing users conservatively.
- Keep one persisted preferred Search plan across model switches and derive a visible model-compatible effective plan for execution without overwriting the preference.
- Preserve the complete preferred plan across settings autosave and accepted-run default persistence.
- Add the default-plan editor to Control Center Search and an ordinary-user path back to the organization recommendation.
- Expose one direct combined Reasoning mode/effort control when the composer has wide/tall working space while retaining the complete More editor on compact/short layouts.
- Persist and restore exact supported reasoning mode/effort values per opaque provider-model deployment, including rapid-switch and reload behavior.
- Update the durable decision, schema migration contract, living Search/backend/frontend/testing contracts, and focused/browser verification.

## Out Of Scope

- New Search adapters, Search grants, provider credentials, or provider request protocols.
- Cross-provider reasoning-value mapping.
- Advertising `reasoning.mode=pro` for a compatible gateway whose bounded live smoke did not complete.
- Applying a new organization recommendation over an existing explicit personal Search plan.

## Acceptance Criteria

- An administrator can save an optimistic-versioned default Search plan from Control Center Search using only ready active options, with copy explaining that it recommends behavior and grants no access.
- A user with no personal Search preference inherits the accessible portion of the current organization plan; a personal plan or explicit Off wins until `Use organization default` is chosen.
- Switching to an incompatible model never mutates the preferred plan. The composer marks retained unavailable engines, the next run uses only the visible compatible effective plan, and switching back or reloading restores the full preference.
- Settings saves and accepted-run persistence cannot replace the preferred plan with a model-clamped subset or convert inherited state into a personal plan.
- Reasoning mode and effort restore independently for two concrete models across A -> B -> A, immediate interaction races, and page reload; stale unsupported values clamp to the model catalog default without cross-family mapping.
- Wide/tall composition exposes the combined current Reasoning value directly; narrow or short-height composition edits it through More and keeps one control-state/action owner.
- Existing users retain their current Search plan/Off across migration, new users inherit, and the migration/default/bootstrap paths are deterministic.
- Focused domain/API/repository/component tests, the Search migration contract, responsive Playwright coverage, docs check, lint, typecheck, and the routine development-Compose check pass.

## Tests

- Focused catalog/settings/admin Search/run-default/domain/component tests.
- `npm run db:search:migration:contract` plus migration deploy, seed smoke, and schema-integrity smoke in the disposable development stack.
- Repository-owned Playwright cases for admin recommendation, inherited/personal/Off behavior, model switching/reload, and wide/mobile/short-height Reasoning disclosure.
- docker compose -f docker-compose.dev.yml exec -T app npm run check.

## Done Notes

- Added the database-enforced singleton, optimistic-versioned `SearchPolicy`
  recommendation and made `UserSettings.defaultSearchPlan` nullable: SQL null
  inherits, a non-null empty plan is personal Off, and a non-empty plan is the
  user's personal preference. The migration preserves every existing plan as
  personal while newly provisioned users inherit; the legacy singleton column
  remains only a rollback/read mirror.
- Current-user catalog and settings contracts now resolve one entitlement-safe
  preferred plan independently from the selected model. The composer retains
  selected incompatible engines with an explicit active/unavailable summary,
  model/profile changes never save Search, and `Use organization default`
  restores dynamic inheritance. Legacy per-model Search hints are no longer
  accepted on writes.
- Send, edit, and regenerate post only the model-compatible effective plan for
  execution plus the complete preferred plan/source. Admission independently
  validates both, and accepted-run persistence stores the preference rather
  than a model-clamped subset in the same locked transaction.
- Control Center Search now edits an ordered zero-to-three-engine organization
  recommendation with orchestration mode, readiness filtering, no-grant copy,
  stale-version fencing, and a removal path when a previously selected engine
  becomes unavailable.
- Reasoning mode/effort remains one exact per-provider/model draft and now has
  a direct combined wide/tall composer control backed by the same store and
  actions as More. Live-store model resolution protects immediate model
  switches; compact and short-height layouts retain only the complete More
  editor.
- Accepted ADR 0046 and updated the owning architecture, backend, frontend,
  pipeline, and testing contracts.
- Verification passed: `npm run db:search:migration:contract`; disposable
  migration reset through focused Playwright; development `db:migrate:deploy`,
  `db:seed:smoke`, and `db:integrity:smoke`; standalone `typecheck`, lint,
  docs check, and diff check; and the complete
  `docker compose -f docker-compose.dev.yml exec -T app npm run check` at 325
  passed files / 2,743 passed tests with 14 opt-in skips.
- Focused Chromium passed all four new cross-boundary scenarios: versioned
  non-granting admin recommendation, inherited/personal/Off Search across model
  switches and reload, global personal multi-engine persistence, and exact
  GPT-5.6 Pro/Maximum reasoning with direct wide versus hidden short-height UI.
- The `v0.1.12` release gate repeated the complete project check and those four
  Chromium regressions, rebuilt the non-root production target, and exercised
  the new migration in an isolated fresh/adopted installation. The repeat
  bootstrap returned `already_adopted`; readiness, login, MCP maintenance
  dry-run, the nullable inherited preference, and exact PostgreSQL/MinIO
  preservation passed before all explicitly named disposable resources were
  removed.
- Published stable Release `v0.1.12` from commit `d314986` through successful
  GitHub Action `30649043039`; all stable GHCR aliases resolve to one
  `linux/amd64` plus `linux/arm64` manifest digest. The guarded selected-target
  rollout found zero active runs, verified its pre-migration backup, applied
  the inherited-preference migration, completed adopted bootstrap, and stayed
  healthy with zero restarts. Authenticated production Chromium proved the
  Search preference remains retained/unavailable across an incompatible model,
  returns on the compatible model, and survives reload without Search fields
  in model-switch writes; it restored the complete original user settings and
  emitted no console or page errors. No provider generation ran and the
  independent companion MCP deployment was unchanged.
