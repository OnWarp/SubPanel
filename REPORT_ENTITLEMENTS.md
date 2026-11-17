# Entitlements implementation

Branch: `task/entitlements-codex`; base: `0c96862`. No remote push.

## Data and central decision

Migration `migrations/0008_entitlements.sql` adds:

- `plans`: name, description, duration, traffic GB, speed Mbps, device count, enabled flag, sort order and timestamps. Zero means unlimited for all three limits.
- `plan_groups`: ordered plan/group associations, following `subscription_groups` and the existing group join-table convention. Group deletion removes its bindings.
- `user_entitlements`: user and plan references, start/expiry timestamps, active/revoked status, admin/trial source, note and timestamps. Expiration is derived, never persisted as a third status. User deletion cascades; referenced plans cannot be deleted. A partial unique index permits one active record per user, including an expired record that can be renewed.
- Nullable JSON `system_settings` entries `trial_plan_id` and `trial_days`; both default to null.

`worker/entitlements/service.ts` owns the only entitlement availability decision, `getUserEntitlement`. It returns `state`, `current`, and `latest`. States distinguish none, expired, revoked, pending, disabled plan and active. The expiry boundary is exclusive (`expires_at <= now` is expired). During migration rollout a missing entitlement table fails closed as no rights; other database failures propagate.

Grants start now and expire after the selected plan's duration. Renewal uses one SQL update to add the plan duration to `max(now, expires_at)`, preventing lost days in concurrent renewals. Switching atomically revokes the old record and inserts a new one; a conditional insertion protects against a concurrent change. Revocation retains the record. Disabled plans cannot be granted or renewed and stop delivery immediately. Plans with entitlement history must be disabled rather than deleted.

## HTTP API and pages

`worker/entitlements/routes.ts` adds authenticated administrator routes:

- `GET/POST /api/admin/plans`, `PUT/DELETE /api/admin/plans/:id`.
- `GET/POST /api/admin/users/:id/entitlement`; POST accepts grant, renew, switch or revoke, optional plan ID and note.
- `GET/PUT /api/admin/entitlements/trial`; null plan or null days disables trial grants.

`GET /api/account/entitlement` supplies the signed-in user's status. Subscription views also include the central entitlement result; administrator user details include it. Account authentication and administrator middleware remain the existing ones.

The new `/plans` page uses shared tables, drawers, form fields and confirmation dialogs. It supports plan CRUD, group checkboxes and trial settings. The administrator sidebar adds one entry. User rows show plan, status and expiry and open a drawer with explicit confirmation for all four operations. Home and My pages show entitlement information; home hides subscription actions when rights are unavailable. Traffic and device limits are explicitly labeled as display/record only.

## Delivery and registration hooks

`worker/delivery/compiler.ts` checks rights before compiling and intersects subscription groups with plan groups. All client artifacts are empty when rights are unavailable. `renderEntitledSubscription` uses the same selection for public requests.

`worker/public-subscriptions.ts` checks live rights before consulting cached artifacts or subscription scheduling. No, expired, revoked, pending or disabled rights produce the existing renderer's native empty representation (e.g. Mihomo `proxies: []`, empty generic payload). This also prevents stale populated KV artifacts and old ETags from restoring revoked access. With valid rights, existing token, owner-deletion, subscription-window and artifact-integrity checks remain, then output is rendered from live rights. Empty permitted group sets return empty output. Unsupported nonempty protocol sets retain the existing compatibility error.

Plan and administrator entitlement mutations refresh compilation, with a warning if compilation fails after the mutation is saved. Live delivery always rechecks rights independently of that refresh.

Speed is injected only for supported Hysteria/Hysteria2 fields in Mihomo, sing-box and Surge; unsupported protocol/client combinations ignore it. Mihomo uses its documented `up`/`down` Mbps fields: https://github.com/MetaCubeX/Meta-Docs/blob/main/docs/config/proxies/hysteria2.en.md . These are client configuration hints, not server-side bandwidth enforcement. Traffic and devices have no usage accounting or enforcement in this phase.

`worker/accounts/registration.ts` inserts the configured trial in the same D1 transaction as self-service registration, guarded by the user insertion. It uses `trial_days` rather than the ordinary plan duration and source=trial. Unset settings or a disabled trial plan skip the grant. Verification consumption, invitation-code consumption, redemption and user creation retain their existing registration behavior. No sales, order, price, payment, ticket or announcement functionality was added.

## Tests and verification

`development/tests/worker/entitlements.test.ts` adds 13 Worker tests covering:

1. No rights, activation, pending start, exact expiry and revocation.
2. Future-expiry renewal and expired renewal from now.
3. Concurrent renewals preserving all days.
4. Plan switching with retained revoked history and duplicate-grant rejection.
5. Plan disablement and referenced-plan deletion protection.
6. Invalid limits, missing groups/users and unavailable operations.
7. Compilation gating and effective group selection.
8. No-rights empty Mihomo/generic delivery and distinguishable status.
9. Expired/revoked empty delivery despite cached artifacts.
10. Group filtering, speed injection, unsupported-format fallback and immediate plan edits.
11. Administrator authorization, CRUD, operations and detail status.
12. Successful trial registration with duration override and no duplicate grant on retry.
13. Trial disabled by missing settings or disabled plan.

Migration test helpers and foundation expectations now include 0008. Existing delivery fixtures explicitly grant plans, including the KV-to-D1 compilation equivalence fixture; production never infers rights from a subscription.

An additional runnable `node development/test-entitlements-offline.mjs` bundles the real Worker application, uses SQLite with a D1-shaped transactional adapter and an in-memory KV, and invokes real Hono HTTP requests without opening sockets. Its ten checks cover migration constraints, authorization, catalog/subscription creation, empty delivery, plan validation, expiry/renewal, filtering/speed, switching/revocation, successful trial registration and transaction rollback when trial insertion fails. Cloudflare-only bindings are test adapters; this does not replace workerd validation.

Verification results:

- `WRANGLER_LOG_PATH=/tmp/entitlements-wrangler.log npm run check`: PASS, zero warnings.
- `WRANGLER_LOG_PATH=/tmp/entitlements-wrangler.log npm run build`: PASS, Worker and client builds.
- `node development/test-entitlements-offline.mjs`: PASS, 10/10 checks.
- New Worker suite bundles successfully with esbuild; `git diff --check`: PASS.
- `npm test`: BLOCKED before any tests execute: the managed shell denies localhost socket creation (`listen EPERM ... 127.0.0.1`). The requested full-suite/smoke regression guarantee therefore cannot be claimed in this environment. The existing tests have been retained.

## Git and bundle hand-back

The checkout's `.git` is read-only (`git add` cannot create `.git/index.lock`). Source changes are present in the requested workspace. The committed branch is prepared in the writable local clone `/tmp/entitlements-handback`, without changing the original checkout's Git metadata or pushing any remote.

The final bundle is `/tmp/entitlements.bundle`, created with `git bundle create /tmp/entitlements.bundle task/entitlements-codex ^0c96862` from that clone and checked with `git bundle verify`.

Bundle hand-back status: pending the SCP attempt; no successful delivery has been claimed.
