SubPanel UI/UX 2.0 Phase 3 test-fix report

Worktree /data/workspace/subpanel-uiux2-phase3, branch task/sub-uiux2-phase3, parent merge 6a6ca1f.

1. Groups — stale test. A cold catalog read passes a loading label into DataTable and lacks a known total. DataTable renders three skeleton rows and marks the table busy. Once a populated catalog is available, the page supplies the actual group count. A loaded, empty catalog uses the page's empty state. The controls test now checks the cold render and then renders with a one-group catalog returned by peekApi to verify the total and the end of the busy state.

2. Nodes — stale test. Section 4 of the UI/UX specification places a list's title and create action on the same row. NodesPage passes 添加节点 to the inline PageHeader. The test now expects that button, verifies the table's loading state and retains the pagination checks.

3. Shares management — stale test. The migration gives the page its own h1 and uses the accessible region label 分享列表 for the list. The previous ashr-shares-title marker belonged to the old card markup. The test now verifies the h1, policy link, named list, search and loading state. The page only supplies the table total after matching shares exist.

4. Sources — product styling regression with stale test expectations. pages-catalog.css uses sources-toolbar for the filter grid, search sizing, reset placement and narrow-screen control sizing. Restored the class on SourcesPage. The test checks the restored toolbar class, the search and status filter, the cold loading state and the create button in PageHeader as specified in section 4.

Changes are limited to development/tests/controls/resource-cards.test.tsx, src/features/catalog/SourcesPage.tsx and this report. The shared-component interfaces needed no changes.

Verification

- Controls, npx vitest run --config development/vitest.controls.config.ts. 36 passed, 0 failed across 8 files.
- npm run check passed. Wrangler types were current while .dev.vars was set aside. TypeScript and lint completed with lint warnings, and the original .dev.vars was restored immediately after the check.
- npm run build passed. Vite reported a chunk-size warning.
- Main suite, npm test. 552 passed, 1 skipped, 0 failed across 68 files.
- Supplemental baseline groups reproduced. pages-node had 234 passed and 1 existing failure in navigation-structure. subscriptions-node had 8 passed and 5 existing failures, four in subscriptions and one in templates-lifecycle. The templates config had 92 passed and 1 existing failure in templates-lifecycle, which overlaps the subscriptions-node result.

- Chromium Playwright, development/tests/browser/topbar-fill.spec.ts. 1 passed in 10.7 seconds. Vite ran from the repository root on port 4173 with SUBPANEL_EXTERNAL_SERVER=1. The existing local state was inspected first. The browser used fresh isolated D1 and KV state under /data with all migrations applied, seven readiness flags, seeded encryption material and a local admin fixture initialized with the existing bootstrap configuration. The tracked screenshot directory was restored after the run.

Open issues

The supplemental failures remain open. The bundle transfer to hwsg:/root/xfer was blocked because hwsg did not resolve from the worktree VM. Instabox also could not issue a loop5 SSH/SFTP certificate because the CLI had no authenticated session or scoped API key available. A destination SHA-256 comparison requires a successful copy. The branch commit includes this report for delivery

SUB_UIUX2_PHASE3_TESTFIX_DONE
