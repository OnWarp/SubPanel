# SubPanel 安全审计

基底 c78fbc4，分支 task/security-audit，与本地 origin/main 一致。Git 身份为 Muse（muse@outtw.com）。参照 docs/subscription-v2-current-state.md、P0–P2 交付报告、CORE §4.5/§4.6/§5.2 与 V2 §5/§12。当前基底没有 P3 报告。审计追踪 Worker 挂载、前端数据流、D1/KV 读写和外联路径，检查 SQL 插值、跟踪文件的凭据特征、npm 锁文件与 Wrangler 配置，并运行隔离回归。生产站点、D1/KV、备份、日志与控制面均未访问，部署侧策略仅能按仓库配置判断。

## 发现与 P4 修复项

| 编号 / 严重程度 | 证据与影响 | 修复建议 / P4 对应项 |
| --- | --- | --- |
| S01 高（空实例） | worker/app.ts:34,50、worker/accounts/public-routes.ts:57–81、worker/platform/crypto.ts:105–119。空实例初始化对外开放，同源检查不验证操作者身份；账号和 KV 密钥初始化都先读后写。公开部署窗口内存在首管理员归属和初始化竞态风险。 | 使用一次性引导 secret 或离线初始化，在权威库原子占用初始化资格。P4 灰度门禁、运维文档及并发回归。 |
| S02 高（旧 KV 模式） | worker/delivery/repository.ts:37–49,66–78、worker/delivery/service.ts:448–460,474–494、worker/public-subscriptions.ts:57–89。旧 KV 快照可作为授权源，传播滞后会延长停用、转移或轮换前链接的有效窗口；并发写入可能覆盖旧快照。 | 对账后切换到 D1 权威读取和条件写；回退保留权威拒绝状态。验证旧链接、跨区域拒绝与并发操作。P4 缓存、旧数据对账、灰度。 |
| S03 高 | worker/system/mail-settings.ts:89–108,151–181、worker/catalog/d1-repository.ts:285–294,369–390、worker/public-subscriptions.ts:158–175、worker/platform/crypto.ts:80–119。邮件密钥直接存入 D1 设置，目录节点凭据和原始变体以可读取形式保存，KV 派生产物包含客户端连接凭据。两项 Workers secrets 均缺失时，DATA 还可存放会话及加密密钥。宽权限读者或备份泄漏可集中暴露凭据。 | 邮件凭据迁入 secrets 或版本化加密存储；生产强制 secrets，建立轮换流程，限制产物保留和备份访问，演练恢复。P4 运维文档、旧数据对账、灰度。 |
| S04 中 | worker/catalog/remote.ts:105–120,225–255、worker/templates/routes.ts:344–387、worker/catalog/import-service.ts:382–405,658–664。通用抓取检查主机名和 IP 字面量，未校验 DNS 解析及实际连接目标。受限地址能否到达取决于运行时出站控制。 | 给目录、模板设置出站允许策略，于可信出站层验证每跳并绑定解析、连接和 TLS 主机。记录脱敏阻断计数。P4 安全、监控。 |
| S05 中 | worker/public-subscriptions.ts:43–89,143–154、worker/delivery/repository.ts:37–39、worker/accounts/public-routes.ts:84–108、worker/shares/service.ts:179–197。公共订阅没有仓库内限流，格式正确的未知 token 也会读存储，命中后还有渲染及统计。旧 KV 登录未受应用限流约束，分享验密也缺少失败预算。外部 WAF 未验证。 | 设置边缘全局和来源预算，应用按账户、订阅或分享摘要限速；用索引查找订阅并监控拒绝率、渲染成本与异常抓取。P4 限流、监控、成本。 |
| S06 中 | worker/accounts/account-routes.ts:21–60,101–126、worker/accounts/email-change.ts:29–79、worker/accounts/d1-repository.ts:167–183。改密码校验旧密码并撤销旧版本会话。改邮箱仅验证新邮箱，未要求近期重新认证或撤销旧会话，新邮箱随后可用来找回密码。普通登出只清 Cookie，全部登出提升会话版本。 | 改邮箱要求近期强认证或旧密码，原子提交验证码与邮箱变更、撤销旧会话并通知旧地址；明确服务端单会话注销策略。P4 安全与账号回归。 |
| S07 中 | worker/templates/validation.ts:49–55,420–434、worker/templates/rule-library.ts:135–158、worker/templates/routes.ts:253–262,313–338,404–408,489–506。发布只核对被 RULE-SET 引用的 provider，其余 provider 仍存在于规范化模板和预览元数据。历史回滚不重跑当前规则源校验。未经同等校验的引用或敏感 URL 可能随配置流转。 | 对所有可输出 provider 执行域名、URL 与引用策略，移除未使用项，回滚前重新验证；统一预览正文与元数据的字段策略。P4 安全、兼容性回归。 |
| S08 中 | worker/platform/http.ts:45–62、worker/admin/audit.ts:7–15、worker/templates/validation.ts:101–144、worker/import/mihomo.ts:269–274。JSON schema 在整个请求读入后验证，审计还会克隆解析。模板和规则格式深度检查在 YAML 解析后，订阅导入缺少统一解析深度预算。超大或复杂输入可提前消耗内存和 CPU。 | 按入口流式限量、超限 413，审计复用已校验字段；在解析阶段限制深度和结构总量，保留别名及大小控制。P4 资源限制与成本验证。 |
| S09 中 | worker/delivery/links.ts:5–15、worker/delivery/routes.ts:145–161,523–550、worker/app.ts:129–141、worker/admin/audit.ts:7–32、worker/catalog/import-service.ts:157–171,674–682,785–799。订阅 bearer 经授权 JSON 和 URL 路径交付，浏览器、客户端和路径日志可能接触。通用异常日志仅遮蔽固定形状的 token，审计取原始路径和部分请求字段，远端 ETag 也进入目录同步元数据。 | 结构化错误与审计只接受规范化字段，日志使用路由模板；在代理、Worker、分析及备份导出验证 URL、凭据和验证码脱敏。P4 监控、运维文档。 |
| S10 中（依赖可达性待确认） | package.json:20–42、package-lock.json。在线 npm audit 匹配 16 个包条目（12 高、4 中）；省略开发依赖后 4 个（3 高、1 中），涉及 React Router 链、Zod 与 Hono。传递条目可以重复，扫描对象是仓库锁文件，本地基线使用已有共享安装。 | 按生产与工具链、调用可达性分流，更新锁文件并以隔离安装验证。P4 依赖安全与发布门禁。 |
| S11 低 | worker/app.ts:38–47,114–127、worker/index.ts:4–8、wrangler.jsonc:6–9,24–32。公开健康响应含初始化及 Cron 状态；资产层可能直接响应，Worker 安全头需要按 API、SPA 和静态资源核验。Cron 复用业务 DB/DATA 权限，入口兜底忽略未处理拒绝。无 Queue 绑定。 | 公开健康接口仅给活性；部署验收覆盖 CSP、Referrer Policy、HSTS；细化任务权限并告警失败。P4 监控、运维文档。 |
| S12 发布门槛（功能尚缺） | worker/app.ts:50–108、worker/delivery/entitlement-templates.ts:32–39,174–175、migrations/0022_subscription_v2_p2.sql:1–15。当前只有兑换资格字段，无 V2 发码、预览、兑换与用户流水。 | P3 交付，P4 按下表验证并发、限流、密钥轮换和权限，验证通过后再启用。 |
| S13 低 | worker/templates/routes.ts:323–340、src/features/delivery/SubscriptionsPage.tsx:994。详情支持打开当前有效版本，逐条诊断未绑定可跳转的版本或草稿，出错时可能只能看到摘要。 | 诊断携带 profile、版本或草稿修订号和字段路径，详情直接定位。P4 排障及回归。 |

## 计划逐项核对

| 要求 | 状态与证据 |
| --- | --- |
| CORE §4.5 HTTPS 白名单、SSRF | 专用规则库已落实固定 HTTPS 源站、无 query/fragment、零重定向（worker/templates/rule-library.ts:8–10,30–36,94–109）。通用抓取及输出引用的剩余范围见 S04、S07。 |
| CORE §4.5 文件、条数、深度、跳转、超时和合并上限 | 已落实专用库 256 KB、10,000 条、7 秒、平面 YAML 与禁别名；sing-box 内联聚合也限制大小及规则数（worker/templates/rule-library.ts:73–109,194–219,248–249）。通用解析阶段见 S08。 |
| CORE §4.5 条件请求与失败保留 | 已落实 ETag / Last-Modified 和 attempt ID 条件更新；失败只写错误状态，保留上次成功 payload（worker/templates/rule-library.ts:99–125）。远程模板手动导入返回候选或 304，失败不覆盖草稿（worker/templates/routes.ts:348–387）。目录刷新失败保留既有内容，并记录 ETag，但常规刷新未从同步元数据构建条件请求（worker/catalog/import-service.ts:658–684,755–796）。 |
| CORE §4.5 发布可用性、客户端引用、服务端转换 | 已落实被引用规则的七日验证、sing-box 内联转换及已验证的固定提交远程 JSON 引用（worker/templates/routes.ts:404–424、worker/templates/rule-library.ts:135–158,185–226,253–269）。未引用 provider 和历史回滚见 S07。规则库与模板抓取均是管理端显式操作，Cron 自动处理的对象是目录订阅来源（worker/app.ts:72–82、worker/templates/routes.ts:185–189,374–387、worker/operations/cron.ts:58–86）。 |
| CORE §4.6 计数、诊断、版本及摘要 | 已落实输入、授权、输出、跳过计数与不兼容节点、组、规则集及格式诊断，输出 renderer、有效版本和摘要（worker/templates/routes.ts:299–340）。真实节点预览按格式隐藏连接参数或移除正文，完整样本来自合成节点（同文件:246–270）。逐条深链和元数据见 S13、S07。 |
| CORE §5.2 D1 权威、即时失效、回退 | D1 模式已落实实时检查 token、状态、到期、账号和权限，并在条件 304 前重算。KV 派生产物不能授权公共输出，生成失败直接报错。旧 KV 模式见 S02（worker/public-subscriptions.ts:52–139、worker/delivery/compiler.ts:188–228）。 |
| CORE §5.2 限流、监控、脱敏 | 已落实按订阅 ID 记录统计、专用公共错误日志采用固定事件或错误码，以及 no-store 和 no-referrer。限流、异常监控与全链路脱敏见 S05、S09（worker/public-subscriptions.ts:58–64,90–97,143–154、worker/platform/http.ts:16–32）。 |
| V2 §5.1 发放与明文 | 未实现（S12）。待验管理员批次与模板版本、至少 128 bit 随机熵、一次展示/导出、不可逆 HMAC 和尾码、Workers secret 及版本轮换、日志和分析脱敏。 |
| V2 §5.1 防枚举与批量限额 | 未实现（S12）。待验单批、单管理员及导出频率，分块预算、预览最小数据、无效/过期/耗尽统一错误，以及用户、IP/会话及全局限流。 |
| V2 §5.2 原子兑换 | 未实现（S12）。待验同事务校验和条件占用、检查受影响行数、创建独立订阅及 token、写流水和审计、提交后响应；以幂等键和唯一约束覆盖重试，并用并发测试验证上限。 |
| V2 §5.3 默认兑换政策 | 未实现（S12）。待验默认单次与账户对同一码一次、显式多次、每次独立订阅、固定模板版本；码到期和停批只影响后续兑换，续期、叠加、共享保留为独立功能。 |

## 已落实控制与误报排除

- worker/app.ts:72–104 的管理挂载逐项核对。管理、账号、计划、注册管理、迁移、系统、域名、目录、两类模板、订阅别名、工单、公告、知识库、分享和应用的管理路由全部处于 requireAuth → requireAdmin。用户订阅列表、详情和两条令牌轮换入口按 principal 过滤或检查归属，跨用户返回 404；普通用户没有模板管理和兑换流水 API。已有注册邀请码流水仅在管理员详情（worker/accounts/auth.ts:9–40、worker/accounts/admin-routes.ts:165–174、worker/delivery/routes.ts:503–550、worker/delivery/service.ts:343–345,474–485）。
- 会话已校验 HMAC、有效期、角色、启用、删除状态和 sessionVersion。Cookie 有 HttpOnly、SameSite=Lax、HTTPS 下 Secure。非安全方法要求同源 Origin，无通用 CORS 放行。未登录、无管理权限、越权对象使用 401/403/404；JSON 类型、语法和 schema 使用 415/400/422，异常为通用 500。SPA fallback 排除 API 并只接受 GET/HEAD HTML（worker/accounts/session.ts:24–69、worker/accounts/auth.ts:9–40、worker/platform/http.ts:35–64、worker/app.ts:114–141）。
- 默认订阅 token 采用 256 bit CSPRNG；数据库保存 SHA-256 摘要与 AES-GCM 密文，D1 有唯一索引，旧快照检查碰撞。旧客户端别名共用 token 检查，旧产物 key 只参与派生写入。token 经授权前端用于复制和导入，未发现持久化到 localStorage。正常订阅输出需要连接数据，预览正文另有脱敏（worker/platform/crypto.ts:45–49,126–138、worker/delivery/service.ts:155–165,448–494、migrations/0001_init.sql:225–241、worker/public-subscriptions.ts:41–52,109–118,181–183）。
- 注册邀请码已有随机 token、摘要与条件占用，创建账号和记录兑换在同一 D1 batch。邮箱验证码有 HMAC 和尝试计数。这两个功能的控制不能证明 V2 订阅兑换已交付（worker/accounts/invite-codes.ts:65–112、worker/accounts/registration.ts:162–248、worker/accounts/email-verification.ts:11–20,47–76）。
- D1 动态 SQL 所见插值来自静态列名、常量映射、占位符和程序拼装条件，外部值走 bind，未确认 SQL 注入。远程抓取已拒绝危险头名称及换行，跨源跳转清空头部；目录 URL、来源原文和头部为加密字段，管理员列表仅显示遮蔽主机。邮件设置响应仅显示是否设置（worker/accounts/d1-repository.ts:61–66,252、worker/domains/service.ts:109–120、worker/catalog/remote.ts:105–143,241–255、worker/catalog/import-service.ts:147–173,382–393、worker/system/mail-settings.ts:111–120）。
- 跟踪文件扫描未命中私钥 PEM、典型 GitHub/AWS 和支付密钥格式。仓库中的合成节点及测试夹具没有计作真实凭据。扫描覆盖固定格式及当前树；其他格式、历史提交、生产日志、备份加密和控制面策略未验证。依赖公告匹配只用于分流，未计为已确认的业务绕过。

## 本地基线

| 命令 | 实测结果 |
| --- | --- |
| npm run check | 通过，0 错误。Wrangler types、TypeScript、Oxlint 均退出成功。 |
| npm run build | 通过。Worker 1,073.57 KB，前端主块 665.16 KB。报告 punycode 弃用及主块大小警告。 |
| CI=1 npm test | 通过，63 个文件、544 项测试全部通过，90.68 秒。 |

SECURITY_AUDIT_DONE
