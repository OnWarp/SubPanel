# SubPanel 订阅 V2 P4 交付报告

分支 `task/sub-v2-p4` 的基底和本地 `origin/main` 均为 `05b50d8db0b8da44d39e4426c97a49a50a615bb8`，提交身份为 Muse（muse@outtw.com）。交付 bundle 为 `/data/tmp/sub-v2-p4.bundle`。构建、测试、对账和压测均在本机隔离环境完成。生产 D1、KV、账户及部署未访问或变更，旧字段清理仅提供提案

## 安全审计逐项闭环

| 编号 | 修复或缓解 | 验证与剩余边界 |
| --- | --- | --- |
| S01 | 初始化要求预置密钥与加密材料。D1 原子条件插入唯一首管理员，在同一批次标记账户就绪 | 错误密钥返回 403，两个有效并发请求返回一个 201 和一个 409。上线后移除引导密钥 |
| S02 | 延续 CORE-F 的 D1 权威公共读取，200 与 304 前核对 token、修订、账户和计划。启用生产安全配置时禁止旧 KV 订阅写入 | 生命周期回归覆盖轮换、停用、撤销、所有权和旧 ETag。KV-only 实例须先通过离线迁移对账，跨区行为等待隔离预发布验证 |
| S03 | 生产密钥必需，邮件凭据仅通过部署密钥配置，KV 派生产物加密且保留一天。D1 目录支持加密节点凭据、TLS、传输、插件、扩展和原始变体，持久标记避免回滚到兼容版本后重新写入明文 | 本机验证加密值、解密和撤去开关后的继续写入。目录须分两次兼容部署，旧 KV 备份和历史邮件设置按审批保留。生产密钥注入、审批后的历史清理和恢复演练仍需集成方完成 |
| S04 | 生产抓取逐跳核对 HTTPS origin，强制交给受信出站 service binding，缺失时拒绝远端请求；跨源重定向清空请求头 | 本机验证缺少网关时的阻断、既有重定向语义和结构化事件。DNS 与真实连接地址校验是网关契约，目标环境尚未配置或验证网关。生产放量前必须验证正常来源可更新 |
| S05 | 公共订阅保留每地址和每订阅 D1 限额，增加可配置的全局限额及 429 分母事件。格式无效请求在计数写入前结束。旧 KV 登录继续使用 D1 失败计数，分享验密跨存储切换共用 D1 原子预算 | 100 个并发竞争 90 个全局名额，30 次分享验密竞争 10 个名额。CORE-F 验证来源超限的 429。生产边缘阈值与真实误伤率待基于获批流量窗口确认 |
| S06 | 改邮箱申请及确认要求当前密码。D1 原子更新邮箱、消费验证并提升会话版本，向旧地址发通知，当前请求换发会话 | 正确密码及验证码才成功，旧会话拒绝、新会话有效，旧地址不可登录。通知投递依赖部署邮件供应商 |
| S07 | 发布校验所有 provider，历史回滚重跑校验，预览在规则源不合格时停止输出源元数据，实际 Mihomo 下发移除未引用 provider | Worker 发布、预览、规则库条件请求、历史版本回退及转换回归。既有客户端订阅路径沿用原契约 |
| S08 | JSON 流式读取设 2,097 KB 上限及 64 层结构预算，审计读取已验证字段。模板与 Mihomo 导入在 YAML 组合前限制 lexer token 数与 parser 栈深度，保留别名预算 | 超限 JSON、深层 JSON 返回 413，深层 YAML 在组合前被拒绝，现有导入和转换测试通过 |
| S09 | 通用错误使用固定事件，管理写审计使用注册路由模板及字段白名单，目录同步停止保存和展示源 ETag，订阅输出 ETag 由正文摘要生成 | 订阅轮换测试检查新旧 token 均未进入审计，旧链接 200/304 与 18 个格式回归。平台调用日志在 Wrangler 配置中关闭，生产代理及导出配置仍待核验 |
| S10 | 核对生产导入链和可部署构建，更新生产 Hono、Zod、React Router 链，采用兼容的 Cloudflare Vitest 插件、Vite、Vitest 和 Wrangler，隔离安装重建锁文件 | 初始全量 16 项；交付 `npm audit` 和生产审计均为 0。Worker 和 Node 回归覆盖更新后的依赖 |
| S11 | 公开 health 仅返回活性，Cron 状态移入管理员入口和系统页，Cron 入口显式报失败事件。HTTPS Worker 响应加 HSTS | 公开响应、授权状态及 Worker 安全头回归通过。资产层继续使用现有头部配置，静态 HSTS、实际告警及部署权限仍须在目标环境核验 |
| S12 | 保留 P3 统一发放事务，预览及确认加稳定账户分桶，灰度涵盖服务端请求 | 本地发码、一次 CSV、预览、确认、幂等、并发、防越权、密钥轮换、审计、流水及已发行订阅回归；500 码成本实测 |
| S13 | 订阅节点诊断定位到当前转换版本及平台。保存草稿的字段诊断链接绑定配置和草稿修订，过时链接提示重新校验 | 既有诊断与前端回归通过。三尺寸截图覆盖兑换管理和个人中心，未单独生成诊断截图 |

## 性能与成本

workerd、SQLite D1 和本地 KV，合成单节点目录及独立订阅、客户端来源地址。每组从同一时刻开始，最多 64 个并发在途，先更新来源以推进目录修订，拉取全部订阅，再复拉同一批。表中为毫秒，包含存储及 `waitUntil` 的墙钟时间；P50/P95 从客户端响应计时，不含响应后的统计写入

| 订阅数 | 冷拉取墙钟 / P50 / P95 | 热拉取墙钟 / P50 / P95 | 来源更新 | 批量装载 |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 25 / 22 / 22 | 18 / 18 / 18 | 32 | 7 |
| 100 | 886 / 628 / 628 | 430 / 227 / 228 | 23 | 4 |
| 1,000 | 6,244 / 348 / 656 | 11,538 / 718 / 1,152 | 22 | 32 |
| 10,000 | 106,742 / 515 / 1,334 | 49,951 / 252 / 519 | 109 | 1064 |

10,000 份的实测操作量为冷拉取 D1 读语句 70,960、写语句 20,000、D1 batch 20,000、KV 读 29,000、写 10,000；热拉取 D1 读语句 70,192、写语句 20,000、D1 batch 20,000、KV 读 20,000、写 0。测试使用本地 KV，生产密钥模式的 KV 加密开销由预发布测量

基线未共享目录快照。交付版按 D1 目录修订与更新时间复用 isolate 内快照，冷读前后检查发布点，所有订阅依旧逐次做 D1 授权检查。原始快照版本变更带来的冷读波次、共享 SQLite/D1 请求队列和渲染后 KV 写入是可见瓶颈。相比目录读取基线，热缓存常态每请求 D1 读语句由 14 降至 7，写语句仍为 2。每请求订阅点查和计划点查共两个 batch，常态约 6 次 D1 调用与 2 次 KV get。数字为本地 binding 调用与 SQL 语句口径

- 10,000 份试验的增量批量写入新增 9,000 订阅和分组关系，D1 meta 统计写入 99,000 行，含索引更新。20 个来源同时编辑，356 ms 返回 3 个 200 与 17 个 409，顺序重试耗时 452 ms，最终全部成功。共享目录快照修订是并发写入的瓶颈
- 生成单批 500 个兑换码用时 13 ms。原子发码 batch 包含 13 条 SQL，D1 meta 读取 504 行、写入 2,015 行。批限流和旁路读取不计入该事务行数
- 兑换全局每分钟 1,200 请求及 300 失败码沿用 P3。本机补齐到 1,190 后新增 20 个并发请求，恰好放行 10。公开全局试验用 90 次/分钟并发竞争 100 次，判定误伤时将已知有效客户端作为单独样本。混合业务下的生产阈值、用量和误伤率待授权观察
- 基准 22,202 个合成公开请求全部 200，该夹具 429 命中率和真实凭据样本误拒率均为 0。该场景分散地址和订阅，不能推广到同一 NAT 或共享订阅
- Worker Standard 超出套餐量时，每百万 Worker 请求边际价为 0.30 美元；百万热拉取约计 200 万次 KV 读，KV 边际价约 1 美元；百万冷拉取按本次比例约计 290 万次读及 100 万次写，KV 边际价约 6.45 美元。批量写入 99,000 D1 行约 0.099 美元，500 兑换码事务约 0.002 美元，均以达到各自套餐额度后计。实际计费还依赖 D1 行读写、存储和 Worker CPU 使用量。[Workers 价格](https://developers.cloudflare.com/workers/platform/pricing/) · [D1 价格](https://developers.cloudflare.com/d1/platform/pricing/) · [KV 价格](https://developers.cloudflare.com/kv/platform/pricing/)
- 交付基准本机进程计 116.15 秒用户 CPU 与 7.26 秒系统 CPU，约 5.56 ms / 请求，含 Vitest、workerd、D1/KV 模拟与测试夹具。该轮与部分回归并行，墙钟含本机争用。Cloudflare 每调用计费 CPU 和生产规模需在隔离预发布及获批的生产指标窗口获取。公开端全局 D1 限额默认未开启，启用后多一次计数写入并有热点开销

复跑命令

```sh
CI=1 VITE_SUB_V2_P4_BENCH=1 npx vitest run --silent=false --reporter=verbose \
  --config development/vitest.config.ts --maxWorkers=1 \
  development/tests/worker/core-f.test.ts -t 'measures P4 public'
CI=1 VITE_SUB_V2_P4_BENCH=1 npx vitest run --silent=false --reporter=verbose \
  --config development/vitest.config.ts --maxWorkers=2 \
  development/tests/worker/core-f.test.ts development/tests/worker/subscription-v2-p3.test.ts \
  -t 'measures maximum|measures concurrent P4'
```

## 灰度、运维和对账

- [运维手册](docs/subscription-v2-p4-operations.md) 包含部署前置检查、应用的账户灰度开关、Worker 版本回切路径、兑换密钥轮换及异常与审计查询。兑换默认 100% 以维持已启用的 P3，配置 0 可临时暂停预览及新确认。目录启用加密写入后，回滚目标须为支持 P4 加密读写的上一稳定部署
- [对账脚本](development/scripts/subscription-v2-p4-reconcile.py) 在离线副本上逐表逐字段核对，输出数量及差异行数。对 P3 中 0022 本地样本模拟 0023 和 0024，1 账户、1 历史订阅、1 归属、1 节点组关系及额度 27.5 GiB 保持一致，缺失、变更、重复 token 哈希、外键异常均为 0。[对账产物](docs/subscription-v2-p4-reconciliation.json)
- [旧字段提案](docs/subscription-v2-p4-cleanup-proposal.md) 包含候选、引用点、迁移与回切。P4 无新增 SQL 迁移或删除旧字段操作

## 验证与文件

| 项目 | 本地结果 |
| --- | --- |
| `npm run check` | 通过，0 错误，保留 React lint 提示 |
| `npm run build` | 通过，Worker 约 1,173 KB、主客户端 JS 约 716 KB。Vite 有大代码块提示 |
| `CI=1 npm test` | 66 个文件，558 项通过，4 项可选压测默认跳过。本阶段新增的 3 项压测另行实测通过 |
| Node/UI 回归 | 15 个文件，229 项全部通过 |
| 本地 Wrangler + Chromium | 1440 px、1024 px、390 px 逐尺寸检查布局和兑换流程。18 条旧订阅路径全部 200，正文摘要、MIME、文件名和 ETag 在兑换前后相同 |
| 依赖 | `npm audit` 与 `npm audit --omit=dev` 均为 0 |

| 页面 | 1440 px | 1024 px | 390 px |
| --- | --- | --- | --- |
| 兑换管理 | [桌面](development/screenshots/sub-v2-p4/admin-1440.png) | [笔记本](development/screenshots/sub-v2-p4/admin-1024.png) | [移动](development/screenshots/sub-v2-p4/admin-390.png) |
| 个人中心 | [桌面](development/screenshots/sub-v2-p4/personal-1440.png) | [笔记本](development/screenshots/sub-v2-p4/personal-1024.png) | [移动](development/screenshots/sub-v2-p4/personal-390.png) |

- `worker/accounts`、`worker/platform`、`worker/admin/audit.ts` 和 `worker/system/mail-settings.ts` 负责初始化、重新认证、密钥、输入预算和审计
- `worker/catalog`、`worker/templates`、`worker/import/mihomo.ts` 和 `worker/delivery/artifacts.ts` 负责出站约束、凭据存储、规则供应者验证和缓存
- `worker/public-subscriptions.ts`、`worker/delivery/public-rate-limit.ts`、`worker/shares`、`worker/redemption/routes.ts`、`worker/operations/cron.ts` 及 `worker/app.ts` 负责限流、灰度和监控
- `src/features/accounts`、`src/features/catalog/SourcesPage.tsx`、`src/features/delivery` 和 `src/features/system` 接入对应 UI
- `development/tests/worker`、`development/test-sub-v2-p3.mjs` 和 `development/screenshots/sub-v2-p4` 是本地验证入口及证据。依赖、测试插件与生成的 Worker 类型在 `package*.json`、`development/vitest.config.ts`、`worker-configuration.d.ts` 更新

SUB_V2_P4_DONE
