# SubPanel V2 P4 运维

## 部署与灰度

1. 记录当前 Worker 版本 ID、绑定、环境变量、迁移台账和部署时间。使用隔离预发布 Worker、D1 和 KV 运行构建、全量回归及 [对账脚本](../development/scripts/subscription-v2-p4-reconcile.py)。生产迁移、导入及发布由获批的操作人执行
2. 从获批的离线备份分别核对账户、目录、订阅的 D1 就绪标记及数据。存在 KV-only 实例时先暂停相关写入，在离线副本上演练现有 `/api/admin/migration/run` 导入顺序 `accounts → catalog → delivery`，检查 owner、token 哈希、到期、额度及分组。已启用 D1 的实例沿用 D1 权威数据。P4 无新增 SQL 迁移。若基底缺少 0023 或 0024，按生产迁移台账逐个执行缺少的单文件，避免对台账不完整的实例批量 apply
3. 核对 `DATA_ENCRYPTION_KEY` 和 `SESSION_KEY`。已有实例将现用值安全导入 Workers secrets，确保旧 token 密文及现用会话仍可读取。新实例使用两个独立的随机 256 位密钥。空实例还需设置一次性 `BOOTSTRAP_SECRET`（至少 32 个字符，随机生成），完成初始化并复查 D1 管理员后移除该部署密钥。邮件选择 `RESEND_API_KEY` 或 `SMTP_URL`，核对 `MAIL_FROM`。对应的历史设置由后续清理审批处理
4. 在预发布设置 `REMOTE_FETCH_ORIGINS` 为经批准的 HTTPS origin 逗号列表，并配置 `REMOTE_FETCH_GATEWAY` 私有 service binding。缺少任一条件时通用远程来源与模板导入会被阻断。网关必须验证每次 DNS 解析的 A、AAAA 及 CNAME，并以已验证公网地址建立连接，保持原 TLS 主机名及证书校验。网关原样返回重定向，由应用清除跨源请求头并重新核验。用合成允许源验证同步、超时、异常计数和保留上次成功内容。专用规则库继续执行固定源站及零重定向策略，所需源站同时纳入网关允许列表
5. 构建后用 `wrangler versions upload` 上传，记录生成的版本 ID。准备一个可回滚的稳定 P4 版本。进行 Worker 版本灰度时，在 Deployments 选择版本及比例，或按 `wrangler versions deploy --help` 使用 Wrangler。兑换在原有上线实例默认 100%。新实例或功能验收期间，给候选部署设置 `REDEMPTION_ROLLOUT_PERCENT=0`，再逐步使用 5、25、100。百分比按账户 ID 稳定分桶，影响预览及确认，历史和运营操作可用。临时暂停时将百分比调至 0，保留台账及密钥
6. 目录加密需要两次兼容部署。先让可解密版本成为稳定回滚目标，旧列仍可读取。随后在同代码新版本设置 `CATALOG_ENCRYPT_AT_REST=true`。下次成功的 D1 目录写入会将当前快照的节点凭据、附属配置及原始变体加密，并写入持久标记。该标记使支持 P4 读取的回滚版本继续加密写入。只在可解密的版本之间进行这一步的灰度。验证授权输出、加密值数量及离线恢复。历史备份和 KV 快照按现有审批权限保管
7. 检查 Worker 版本指标、Cron、错误率、有效客户端误伤率、限流率、D1 行读写、KV 操作量与 CPU 分布。保留同一清单中的基线和候选窗口。通过后继续放量。Cloudflare 控制台的版本分流与应用兑换分桶独立，验收兑换分桶时给候选 Worker 100% 版本流量或在其独立预发布环境测试

## 回滚

- 应用紧急停止新兑换时，切回配置为 0 的 P4 版本。已发放订阅及兑换流水继续使用当前数据和原密钥映射。系统级故障在 Workers & Pages → Worker → Deployments → 目标版本菜单选择 Rollback，或运行 `npx wrangler rollback <上一个稳定版本ID>`。确认控制台路由已切到该版本并回归旧链接、登录、缓存重建及 Cron。[Cloudflare 版本回滚](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- 保留 D1 就绪标记、授权撤销状态、KV 命名空间及迁移台账。目录写入加密后，回滚目标必须支持 P4 密文读取。若唯一旧版本无法读取密文，使用已保留的兼容版本前滚修复。授权与数据备份恢复分别审批
- 回滚后可出现前端缓存与版本切换间短时不一致。用新会话复测 API、SPA、静态资源和转换请求，避免在日志或工单附带完整 URL 或验证码

## 兑换密钥轮换

1. `REDEMPTION_HMAC_KEYS` 为 JSON 对象，`active` 指向当前版本，`keys` 映射版本到无填充 base64url 随机 256 位密钥。最多四个版本。用密钥管理工具生成新密钥和全新版本标识，在密钥存储中准备重叠映射
2. 部署相同 active 且包含新版本的映射，验证旧码预览。随后切换 active，新批次用新版本签发。核对第二次显示以及 CSV 的服务端一次释放约束，确认旧映射仍可预览、兑换和重放成功收据
3. 用授权的离线 D1 副本按 `digest_key_version` 汇总有效批次及剩余次数。旧版本下所有码到期、用尽、停用或作废之后移除旧版本。保留历史备份的恢复能力，检查回滚部署所需的重叠映射
4. 会话密钥轮换会使现用会话和验证码失效。数据加密密钥用于历史 token、来源和目录数据，先规划有序重加密及恢复演练再切换。邮件密钥在服务端供应商与 Workers secrets 双端交接，使用预发布邮件探测核对配置

## 监控与故障定位

| 问题 | 可查入口 |
| --- | --- |
| 远程来源与规则异常 | Workers Logs 的 `remote_fetch_blocked`、`cron_failed`、`cron_status_write_failed`，来源详情的同步记录，规则库列表。管理员可调用 `GET /api/admin/operations/status` 查看最近 Cron |
| 公开订阅成本和限流 | Workers Logs 的 `subscription_delivery` 及 `subscription_fetch_rate_limited`。按状态、平台、缓存命中和 scope 聚合。后者只记录窗口首次越阈。Workers Metrics 查看请求和 CPU，D1 Row Metrics 查看行读取/写入量，KV Analytics 查读写量 |
| 审计 | 管理端 `GET /api/admin/audit-logs` 按 action、actor、from、to 查询，兑换批次详情的审计及兑换流水交叉核对 |
| 503 或部署后功能失效 | 查灰度百分比、密钥配置、D1 就绪状态和迁移台账，核对同一请求的 Worker 版本 |
| 429 或共享代理集中报错 | 同分钟计算 429 / 全部订阅请求。合成有效客户或有明确工单的有效请求作为误伤分母，计算被拒的有效请求 / 有效请求。IP 和全局早拒绝不能推断真实误伤率。先用预发布已知有效探测区分地址、订阅和全局阈值 |
| 版本诊断 | 在订阅诊断逐条打开当前 Mihomo 或 sing-box 版本预览，检查对应节点和字段；草稿校验记录修订号和字段路径 |
| 安全头与日志 | API、订阅、SPA、静态资源分别验证 CSP、Referrer-Policy 和 HTTPS 上的 HSTS。静态资源的 HSTS 依赖经批准的边缘设置。日志只查询已脱敏的结构化事件，核对平台日志、转发代理及导出的字段配置 |

公开端默认按地址 240 次/分钟、订阅 120 次/分钟。可在隔离环境用 `PUBLIC_FETCH_GLOBAL_LIMIT` 实测全局预算，0 代表未启用。单个全局 D1 行会随每个候选请求写入，生产全局策略应在边缘与 D1 单热行压测后确定。兑换现行全局请求/无效阈值为每分钟 1,200 / 300。D1 出现排队或高写行数时，先查看峰值和误伤探测，再决定边缘限流和应用阈值

公开 `/api/health` 仅返回活性。Worker 调用日志保持关闭，巡检以自定义事件为主。日志查询时按版本和时间窗口过滤，保留计数与时延，避免收集请求 URL。[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
