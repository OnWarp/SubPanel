# SubPanel PR6 test fixes

Branch `task/sub-unified-pr6-full`, based on `eef5438`. Changes cover tests and fixtures for the PR6 contracted Worker and browser UI.

## Failure classes

| Area | Root cause and fix |
| --- | --- |
| D1 fixtures | Worker integration tests still initialized the earlier schema. Added a contracted fixture that applies migrations through 0028, seeds the seven readiness flags, and applies the full contraction in one D1 migration batch. Historical repository and migration fixtures still initialize the schema their replay tests exercise. |
| Catalog, account details, domains and node lists | Fixtures created legacy subscription rows or expected data derived from them. Switched current cases to entitlement template bindings and verified binding counts, catalog impact, ownership, node visibility, pagination, domain selection, and unified link generation. Verified that a deleted account with archived history remains in the recycle bin. |
| Delivery and lifecycle | Tests used retired `/sub` links, per-subscription CRUD, compilation, and template-managed output. Asserted retirement and exercised `/s` delivery, built-in renderer formats, certificate fingerprint conversion, conditional requests, catalog edits, expiration, token rotation, and the current address and global admission windows. Retained historical compile job listing coverage and verified the execution and retry responses for retired jobs. |
| Entitlements and traffic | Plan operations need linked entitlement templates and revision-aware requests. Updated the fixtures and kept coverage for renewal, stale revisions, switching, revocation, registration trials, and omission of unmeasured traffic. |
| Shares | Creation and export now use unified scopes. Updated fixtures and assertions for password, login, expiry, limits, access counts, token rotation, original-link restrictions, and revoked share history. |
| Redemption and entitlement templates | Legacy issuance created subscription rows, while current redemption creates or renews bindings. Updated the redemption fixtures and history assertions while preserving concurrency, rollback, idempotency, release quota, and key rotation checks. Live entitlement template versioning, copy, private ownership, and group references still have coverage. Replaced retired delivery-template endpoint assertions with retirement checks. |
| Unified subscription | Removed observations specific to shadow comparison, retired backfill entry points, the waived compatibility window, and configurable conversion. Ran the live aggregation, revision conflict, isolation, resource limits, and token tests on the contracted schema. |
| Browser setup and shell | First-run setup now supplies the initialization key once for the local server. Later flows sign in with the fixture administrator. Updated the guest theme storage, current palette and navigation, group and invite dialog selectors, and restored the fixture password after verifying rotation. |
| Browser delivery and authorization | Retired conversion and subscription management surfaces gave way to the entitlement template and user authorization flows. Updated the private-template fixture, the queued batch progress assertions, and the ordinary user's unified import, share, and link rotation tests. Hover checks now distinguish actual visual coverage from hit testing on a button descendant or native touch hover state. |

## Re-verification

| Gate | Result |
| --- | --- |
| `npm run check` | Exit 0. Existing lint warnings. |
| `npm run build` | Exit 0. Existing bundle-size advisory. |
| `CI=1 npm test` | 68 files passed, 550 tests passed, 1 benchmark skipped, 0 failures. |
| Playwright | 107 Chromium cases passed, 0 failures, exit 0 (4.2 minutes). |
| Empty D1 | All 27 migrations applied through 0028 to a fresh local D1, followed by the contraction. Integrity `ok` and 0 foreign-key violations. |
| Existing D1 | Migrated an isolated database through 0027, inserted a sentinel, then applied 0028 and the contraction. Sentinel retained. Integrity `ok` and 0 foreign-key violations. |
| Isolated backup rehearsal | Restored the cutover-preflip SQL and ran the full contraction SQL as a single local Wrangler D1 batch. Integrity `ok`, 0 foreign-key violations, 4 archive rows, 4 mappings, and 4 bindings. All six rebuilt foreign keys target the archive. The current Worker resolver returned an active unified summary with 63 nodes. |

Playwright used Vite started from the repository root on port 4173 with `SUBPANEL_EXTERNAL_SERVER=1`, a fresh local D1 from the contracted migrations, seven readiness flags, seeded local KV crypto material, and a local bootstrap secret.

The fresh hwsg transfer attempt failed because the hostname did not resolve. The rehearsal used the existing local copy of `subpanel-d1-backup-20261125-cutover-preflip.sql` after independently verifying SHA-256 `22b52f8f5cf811da899804661e2ac3b96a7f9c8977435522c7fa8857f66290c7`.

SUB_UNIFIED_PR6_TESTFIX_DONE
