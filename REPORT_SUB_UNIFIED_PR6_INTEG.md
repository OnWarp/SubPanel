# SubPanel PR6 全量收缩：集成＋生产执行

分支 `task/sub-unified-pr6-full`（HEAD `b3687ae`）已合入 main、复验、部署上线，生产收缩 SQL 已执行并核验。本次按 Roye 20:59 的点头续跑：**未碰 bundle 文件**，直接从 GitHub origin 拉分支消费。

## 集成

- 集成仓 loop2 `/data/workspace/subpanel-integ`，临时分支 `integ-pr6-full` 从 `origin/main`（`c57d6778d`）起，合并 `b3687ae`，无冲突；合并提交 `e16c4cf4f`（Merge task/sub-unified-pr6-full: PR6 full contraction + test fixes）；树与 `b3687ae` 完全一致（diff 为空）。
- 已推 main：`c57d6778d..e16c4cf4f`，`git ls-remote` 核对 main 为 `e16c4cf4f1249998c19fc06cb76301c2b201f90a`。

## 复验（集成仓，全部通过）

| 门 | 结果 |
| --- | --- |
| `npm run check` | 退出 0 |
| `npm run build` | 退出 0 |
| `CI=1 npm test` | 68 文件通过，550 通过、1 benchmark 跳过、0 失败 |
| D1 空库全量 | 27 条迁移至 0028，补 7 个就绪标志，跑收缩 SQL；integrity ok、外键违规 0、64 张表、旧表全无、归档表在、6 条重建外键全指归档 |
| D1 存量增量 | 经 0027 插哨兵后补 0028，跑收缩 SQL；integrity ok、外键违规 0、64 张表、哨兵保留 |
| D1 隔离演练 | 生产 preflip 备份（sha256 `22b52f8f…90c7` 已验）恢复后跑收缩 SQL；integrity ok、外键违规 0、归档 4 行、映射 4 行、绑定 4 条、6 条重建外键全指归档 |
| Playwright | 107 Chromium 用例通过、0 失败（3.9 分钟） |

两点复验备注：

- D1 验证用的 `pragma_integrity_check` / `pragma_foreign_key_check` 在 `wrangler d1 execute` 下报 `SQLITE_AUTH`（不让跑 PRAGMA），integrity 与外键改用 python3 直读本地 sqlite 文件核对。
- 首轮浏览器回归 19 失败、69 通过，根因是本地 Worker 没拿到 `BOOTSTRAP_SECRET`：loop2 上 vite 日志没有 `Using secrets defined in process.env`，即 process.env 注入走不通，初始化接口报 403 `SETUP_FORBIDDEN`，后续用例连锁失败。改用 gitignored 的 `.dev.vars` 写同一份密钥后重跑，107 全过；`.dev.vars` 已删。不是产品问题。

## 部署

- hwsg `/root/subpanel-dev` 同步 `origin/main`（`e16c4cf`）→ build 过 → OnWarp workers_shared 令牌部署。
- 新版本 `13f50505-302b-466f-8316-8dd0a80baac8`（100% 流量，`deployments list` 末尾确认），自定义域名 `sub.warp.dpdns.org`。
- 上线核验：`/`、`/health`、`/api/health`、`/login`、`/me`、`/admin`、`/delivery/migration` 全 200，`/api/health` 返回 `{"ok":true}`。

## 生产执行（先部署后跑 SQL）

- 执行前备份：hwsg `/root/subpanel-d1-backup-20261125-pr6-full.sql`，275,570 字节（约 269 KB），SHA-256 `90d9acd207b26ad1c81ce4f81c8cf1957174aaed3409ec05dd8d6381fcf99dd1`。
- 前置条件只读重探全过：用户 2、旧订阅 4、映射 4、绑定 4、旧模板四张表 0 行、转换四张表 0 行、排队/运行中编译任务 0、两开关均为 `true`、`cutover_at` 仍为 `1795606612798`。
- 执行 `docs/unified-subscription-pr6-full-NOT-EXECUTED.sql`（单个原子批次，`wrangler d1 execute subpanel-d1 --remote --file=…`）；守卫未拦截。
- 执行后核验全过：表 65 张、归档 4 行、映射 4 行、绑定 4 条、用户 2、权益模板 6；旧 `subscriptions`、旧模板四张表、转换四张表共 9 张表均已消失；6 条重建外键全指归档表；执行后导出全库以 python3 sqlite3 直读：integrity `ok`、外键违规 0。
- 线上核验：各页全 200；旧 `/sub` 任意 token 与空路径均 404（兼容入口已退役，符合预期）；统一订阅链接实测：wuyang 的统一链接取 mihomo 格式返回 200、`text/yaml`、63 个节点（与演练的授权筛选去重后 63 个一致），token 前缀与库内记录一致。

## 计数口径订正（执行时发现，与早先记录不同）

- 生产执行前实际是 **73 张表**，不是 72 张：多出的一张是 Cloudflare 内部表 `_cf_KV`（19:36 preflip 备份里没有，之后出现；不在收缩范围，SQL 不碰它）。因此收缩后是 **65 张**，不是 64 张（73 − 9 删表 + 1 归档表）。演练用的 preflip 备份是 72 张，演练后 64 张，两边各自一致。
- 权益模板实际是 **6 个**，不是 2 个：18:39 探查时 2 个，19:33 影子迁移为 4 条旧订阅各建了 1 个私有模板，之后一直是 6 个；preflip 备份与演练结果同样是 6 个。

## 未动与遗留

- 未碰 bundle 文件（loop2 `/data/tmp/sub-unified-pr6-testfix.bundle` 留在原处未用）；生产除收缩 SQL 外无其他写入；main 除合并提交与本报告外无其他提交。
- 本地临时脚本与执行后导出已清理；执行前备份留存在 hwsg `/root/`，回滚方案见 `docs/unified-subscription-pr6-full-rollback.md`。

SUB_UNIFIED_PR6_INTEG_DONE
