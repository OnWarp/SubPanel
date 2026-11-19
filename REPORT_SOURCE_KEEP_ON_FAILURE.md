# 来源拉取失败时保留节点

基线为 `a818d3a7`，交付分支为 `task/source-keep-on-failure`

## 存储与兼容性

- D1 迁移 `0016_source_keep_on_failure.sql` 为 `sources` 表增加 `keep_on_failure INTEGER NOT NULL DEFAULT 1`，约束值为 `0` 或 `1`。已有行读取为 `1`，写入时 `convertCatalog` 将布尔值转成整数，由 D1 来源 upsert 保存
- `readCatalogFromD1` 只把 `0` 解析为 `false`，缺列时解析为 `true`。`sourceBaseSchema` 使用 `z.boolean().default(true)`，覆盖 KV 快照读取、旧快照升级和 KV 到 D1 的转换
- 创建来源省略该字段时默认开启。更新来源省略该字段时延用当前设置。来源摘要返回布尔值。远程来源可通过行菜单即时切换，也可在编辑弹窗保存
- 手动与定时刷新共用 `refreshSource`。关闭开关后，失败分支直接向 `applyImport` 传入空节点列表，保留原始失败码和上次成功时间。节点级 `retained` 与共享节点继续使用原有对账规则

## 四项新增 Worker 测试

四项均使用原测试断言在 Node Vitest 中通过，绑定由临时 SQLite D1 和内存 KV 适配器提供

| 场景 | 结果 |
| --- | --- |
| 开启时收到 HTTP 503，原节点数据保持一致 | 通过 |
| 关闭后收到零节点响应，来源独占节点清除，仍返回 `success: false` 和 `IMPORT_ZERO_NODES`，上次成功时间保持一致 | 通过 |
| 关闭时刷新失败，`retained` 节点存活且失败来源关联与原始变体被移除 | 通过 |
| 关闭时刷新失败，共享节点保留其他来源关联，其他来源独占节点保持一致 | 通过 |

## 验证结果

| 命令或检查 | 实测结果 |
| --- | --- |
| `npm run check` | 退出码 0。Wrangler 类型检查、TypeScript 和 Oxlint 三个阶段通过。Wrangler 日志使用可写的 `XDG_CONFIG_HOME` |
| `npm test` | 退出码 1，0 条执行。Worker 测试池启动时在 `127.0.0.1` 监听失败，报 `EPERM`。简报基线 481 条，本次新增 4 条，预期 485 条 |
| 临时 Node Vitest 配置运行 Catalog 导入和快照迁移测试 | 2 个文件，19 条通过，其中新增项 4/4 |
| SQLite 迁移冒烟检查 | 3 项断言通过，覆盖已有行读为 `1`、可持久化 `0`、拒绝 `2` |
| `npm run build` | 退出码 0。Worker 转换 284 个模块，前端转换 1943 个模块。生产构建提示前端入口超过 500 kB |
| `npx vitest run --config development/vitest-pages-node.config.ts` | 14 个文件，189 条通过 |
| `node development/test-pages-offline.mjs` | 3 条通过，0 失败 |
| `npm run test:e2e` | 退出码 1，0 条执行。Vite 启动时网络接口枚举报 `uv_interface_addresses returned Unknown system error 1`。Playwright `--list` 成功列出 5 个文件、37 条 |

集成时在 loop2 复跑完整的 Worker Vitest 和 Playwright 套件
