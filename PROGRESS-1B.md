# D1 batch 1B progress

- migration-accounts.test.ts: 6 passed. Fixtures: PBKDF2 salt/hash replaced with 22/43-char base64url. Property test reapplies migrations after emptyDatabase (that helper drops tables).
- migration-apps.test.ts: 3 passed. Fixtures: omitted developer null and fileSizeKb null (schema is optional, not nullable). Converter reports a platform that points at a missing app instead of throwing on the snapshot refinement.
- migration-catalog.test.ts: 7 passed. Fixtures: encrypted payloads are AES-GCM objects with 16-char iv and 32-char ciphertext; null encrypted/url/header/interval/format/error fields omitted so manual and file sources stay schema-valid. Converter reports dangling ids instead of throwing on the snapshot refinement.
- migration-delivery.test.ts: 2 passed. Fixtures: tokenHash is 43-char base64url; encrypted token iv/ciphertext match encryptedValueSchema. Property test reapplies migrations after emptyDatabase.
- migration-shares.test.ts: 7 passed. Fixtures: token hashes, password salt/hash, and encrypted tokens match the schemas. Property test reapplies migrations after emptyDatabase, and the shares INSERT placeholder count matches the 27 columns.

## Final summary

Fixture faults (schema rejects the value before conversion):
- accounts: `password.salt` / `password.hash` were not base64url of length 22 / 43.
- apps: `developer: null` and `fileSizeKb: null` are not valid. Stored apps omit those fields (`developer` is an optional string; `fileSizeKb` is an optional number). The converter still writes SQL NULL when the field is absent.
- catalog: `encryptedContent` / `encryptedUrl` / `encryptedHeaders` were `null` or had ciphertext shorter than 22 base64url characters. Remote sources now carry real AES-GCM objects (16-char iv, 32-char ciphertext). Manual and file sources omit URL, headers, and refresh interval. `lastErrorCode`, `detectedFormat`, `plugin`, and `transport` nulls were omitted the same way.
- delivery: `tokenHash` was 41 characters, not `/^[A-Za-z0-9_-]{43}$/`, and token ciphertext was shorter than 22 characters.
- shares: same token-hash, salt, hash, and ciphertext mismatches, including the duplicate-id case whose replacement hash was not 43 characters.

Converter bugs (schema-valid anomaly input threw instead of reporting):
- apps: `appsSnapshotSchema` superRefine throws when a platform points at a missing app (and when `nextPlatformId` is not above every id). `convertApps` now keeps the strict parse for valid snapshots and, on failure, parses the same object shape without that refinement so the existing anomaly string is returned.
- catalog: snapshot superRefine throws on dangling source/node ids, missing raw variants, and unrelated raw-variant sources. `convertCatalog` uses the same strict-then-structural fallback. Element schemas (`sourceSchema`, `nodeSchema`, `groupSchema`) still apply.

No converter logic change was required for accounts, delivery, or shares. Their anomaly cases already use `safeParse` or do not trip a snapshot refinement.

Test-harness faults found after the fixtures parsed:
- Every property test called `emptyDatabase`, which drops tables, then inserted. Each test now calls `applyMigrations` again so the D1 constraints actually run.
- The shares INSERT listed 29 placeholders for 27 columns.

Final counts:
- Five migration files: 25 passed (accounts 6, apps 3, catalog 7, delivery 2, shares 7).
- Full `vitest run`: 39 files passed, 267 tests passed. The only failure is the pre-existing `smoke.test.ts` suite load error (`public/_headers` ENOENT).
- `npm run check`: passed (0 warnings, 0 errors).
- `npm run build`: passed.
