# Subscription templates delivery report

Baseline: `833c093340f0e7b139fab053cf00034cdbacdd70`, branch `task/subscription-templates-codex`

Read BRIEF_SUBSCRIPTION_TEMPLATES.md first, then SPEC_TEMPLATES.md. The local origin/main reference equals the baseline. Fetching current GitHub main was attempted from a writable clone but failed with `Could not resolve host: github.com`; freshness beyond the available baseline cannot be confirmed. The source worktree's Git metadata is read-only, so the commit and bundle are made from `/tmp/templates-git` on the same branch. No push or scp

## Implementation by requirement

1. D1 first: migration 0015 adds template metadata/drafts, immutable published versions, a singleton default pointer, and per-subscription bindings. Initial default is NULL (base configuration); missing bindings mean inherit. No 0012–0014 changes
2. Built-in rendering: final live entitlement compilation resolves D1 templates for Mihomo. It retains entitlement/group intersection, protocol compatibility, certificate conversion and speed handling. Renderer expands parsed member arrays after compatibility filtering; collisions with groups, reserved targets and other generated names receive unique suffixes. Base rendering is unchanged
3. Validation: YAML parser errors and Zod field paths, duplicate names, reserved names, unknown members/targets/providers, cycles, empty groups, dynamic-select requirement, misplaced placeholders and terminal MATCH validation. Only select groups and supported inline rule types are accepted. HTTP rule-providers require HTTPS declarations. Full-config fields outside the three accepted keys are ignored and reported. Drafts may be invalid; publishing validates before changing the live pointer
4. Bindings: inherit, specific published template, and explicit base stored separately from subscription models. Existing subscription editor exposes an immediately saved binding control. Creating a subscription inherits by omission; reopen it to select a specific policy. Referenced/default templates cannot be archived, including concurrent reference writes checked inside their SQL statement. Deleting a subscription removes its binding
5. Admin: added within existing system settings domain section without altering navigation or AppShell. Existing FormField, DataHeader, StatusMessage and button/color styles are reused. List includes name/status/published time, edit/preview, and more disclosure for rollback/archive. Editor supports named drafts, YAML, optional subscription preview, publish, version selection and remote import. Changing the preview subscription clears stale preview output
6. Preview: same entitlement compiler and renderer; exposes name, output count, members, ordered rules, ignored fields and four zero-node reasons. The API returns policy structure only; no proxy address, credential or token is serialized. No actual client subscription URL is emitted in preview
7. Cache: public endpoint still verifies KV artifact existence/schema/subscription and catalog revisions, then renders with current D1 published pointer and hashes the final body through the existing artifact compiler. Template publication does not mutate tokens or subscription revisions or rewrite subscriptions. Rollback with equal output restores equal ETag. Explicit Mihomo, aliases and UA detection converge before this path
8. Empty output: renderer applies no template when there are no compatible candidates; compiler skips D1 resolution for no entitled/enabled nodes. Existing empty/error behavior remains
9. Remote import implemented last: explicit administrator POST only, using existing fetchRemoteText/validateRemoteUrl. HTTPS, credentials/unsafe target rejection, every redirect target checked, 15-second timeout, 5 MB streaming cap and bounded redirects are inherited. One import operation per click, no retries, probing, scheduled task or background refresh. Failure returns to administrator without modifying draft/publication. Successful import replaces only draft/source URL. Rule-providers are declarations only and never fetched by the server
10. Subscription-model boundary: no subscription owner schema, assignment or transfer code was changed. Missing owners remain refused by the public owner lookup. The available baseline has no transfer feature/unassigned-owner schema from the parallel model line; its future merge still needs integration verification. Expiry refusal was moved before the entitlement branch, correcting the available baseline's contrary order. No token rotation behavior was removed or replaced

## Migration and deployment notes

Apply `migrations/0015_subscription_templates.sql` through the existing D1 migration process before deploying this Worker. Numbering deliberately skips reserved 0013/0014; invites 0012 remains untouched. The migration adds four tables and seeds one NULL default; it does not alter existing subscription columns or data. All versions are retained, exceeding the requirement to keep at least one previous version. Bindings use subscription IDs without a foreign key because existing delivery supports both KV and D1 backends; application deletion cleans them up. Archived templates/versions are retained

All 13 present migration files applied sequentially to an in-memory SQLite database; seeded default was `(1, NULL)`. Worker test migration helper and expected table/migration list include 0015. Cloudflare D1 migration replay itself could not be executed in this sandbox

## Section 5 acceptance results

| Scenario | Self-test result and limits |
| --- | --- |
| Existing users/original link | PASS at resolver/render level: missing binding and NULL default produce byte-identical base output. Public route/URL structure unchanged. Live original-link HTTP refresh unverified because Worker runtime cannot listen |
| Single subscription trial | PASS: SQLite-backed management-route test binds trial only; trial changes while unrelated subscriber output remains original |
| Publish default / old ETag | PASS at management/resolver/final-body digest level: default pointer immediately changes inheritor output and digest, explicit base remains identical. Existing public endpoint compares artifact ETag after live rendering. Actual HTTP 200/304 exchange unverified |
| Clash/Mihomo client | UNVERIFIED: no Mihomo/Clash executable installed and localhost runtime blocked. Generated parsed YAML has a select group with actual nodes, ordered LAN DIRECT rule and MATCH fallback; actual import, rule-mode switching and traffic routing have not been exercised. This spec release criterion remains outstanding |
| Different entitlements | PARTIAL: renderer test gives the same template distinct prefiltered node sets and verifies isolation. Existing compiler entitlement/group filtering was retained. Two real users through live compiler/public requests unverified |
| No nodes | PASS at renderer and preview-route level: empty/disabled input ignores template; mocked compiler/rights fixtures exercise all four preview reasons. Full entitlement data integration and public empty/error HTTP behavior unverified |
| Invalid configuration | PASS: seven invalid-template cases plus lifecycle test reject publishing invalid draft while published output stays identical. Error paths identify groups/rule positions or schema fields |
| Remote failure / rollback | PASS: mocked single fetch failure and unsafe redirect target preserve publication and stop; HTTP URL blocked without fetch. Successful import stays draft until publication; rule-provider URL never triggers another fetch. Rollback restores original bytes and final-body digest. Real external HTTPS import unverified |
| Other formats | PASS: eight non-Mihomo formats unchanged with template supplied; all existing renderer/compatibility tests pass |

## Checks and test conclusions

- `XDG_CONFIG_HOME=/tmp/templates-config npm run check`: PASS (Wrangler type check, TypeScript builds and oxlint)
- `XDG_CONFIG_HOME=/tmp/templates-config npm run build`: PASS, Worker and SPA production bundles. Vite reports its existing large client chunk advisory
- `node node_modules/vitest/vitest.mjs run --config development/vitest.templates.config.ts`: PASS, **80 tests in 5 files**. This includes 27 new template tests and 53 existing renderer/compatibility/remote tests
- Baseline focused tests run independently in the pristine clone: **53 passed in 3 files**; all 53 still pass after changes
- Full baseline `npm test` and full changed `npm test`: BLOCKED at startup by sandbox `listen EPERM ... 127.0.0.1`. An initial attempt also hit read-only dependency cache writes; dependencies were copied to `/tmp` and the local node_modules symlink repointed there, without staging it. Therefore a full baseline executed test count and a full-suite nonregression result cannot honestly be reported
- New lifecycle tests use an in-memory SQLite adapter for D1 operations and mock subscription lookup/compiler/entitlement services, plus mocked fetch. They exercise real template routes, schema, validation, renderer and resolver, not the Worker runtime
- `git diff --check`: PASS
- No browser UI automation, actual client network routing, deployed D1, production Worker or external network import was verified. No deployed service was modified

Artifact: `/tmp/subscription-templates.bundle`, branch `task/subscription-templates-codex`. Commit is in the writable clone; source worktree edits remain available for review because its Git metadata cannot be written
