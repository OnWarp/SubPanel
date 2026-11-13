# 域名阶段交付报告（task/domain-stage-sub）

基线 36be1ac，迁移 0007，独立实现，未触碰 APP 阶段 worktree。

## 测试与校验

- 全量测试：**362 个测试全部通过**（基线 348＋新增 14），唯一失败是 smoke.test.ts 的 `public/_headers` ENOENT（worktree 环境问题，简报豁免项，与本阶段无关）
- `npm run check` 通过（wrangler types＋tsc＋oxlint；仅有既存警告 d1-admin-users.test.ts 未用导入，非本阶段引入）
- `npm run build` 通过

## 交付内容

### 迁移 0007（migrations/0007_domain_stage.sql）

- 新表 `subscription_platform_settings`（平台/展示名/启用/排序），种子 13 行与现网用户订阅页链接条目同序同名、全启用
- 新表 `panel_domains`、`subscription_domains`（hostname 唯一、enabled、verification_status pending/verified/failed、verified_at、last_check_at、last_check_error、note、时间戳）
- 两表各预置一行 `sub.warp.dpdns.org`（确定性 id `dom_panel_primary`/`dom_sub_primary`，enabled=1、verified、INSERT OR IGNORE 幂等），system_settings 预置 `primary_panel_domain_id`、`primary_subscription_domain_id` 指向它们、`domain_restriction_enabled`='false'

### 后端（worker/domains/）

- `platforms.ts`：13 个链接平台键＋展示名单一来源，delivery 链接生成改用同一清单
- `service.ts`：域名规范化（trim/小写，拒绝 scheme/路径/端口/凭据/空格/无点主机名）、按表 CRUD（重名 409）、启用与设主校验（未 verified 一律 422 DOMAIN_NOT_VERIFIED）、主域名保护（删除/停用 409 DOMAIN_PRIMARY_LOCKED）、平台设置读写（全量校验：未知/重复/缺失 422）、主域名解析（指针悬空返回 null）、`instance_id` 惰性生成（`ins_`＋32 hex，存 system_settings）
- 域名验证：仅管理员手动触发，单次 GET `https://<hostname>/api/system/instance`，AbortController 5 秒超时、零重试、比对 instance_id；结果（verified/failed＋摘要 ≤200 字）落库；不请求任何订阅内容
- `host-gate.ts`：门禁中间件，注册在 originGuard 之后；豁免 `/api/health` 与 `/api/system/instance`；Host 只取请求 URL、永不读 X-Forwarded-Host；分类＝`/sub/*` 与公开分享 API（meta/verify/export）为订阅类，其余为面板类；开关关＝直通，开时对应类已启用域名集合为空集＝自动不拦截（防锁死）；拦截返回 404 DOMAIN_NOT_ALLOWED；门禁状态 15 秒进程内缓存、所有域名/开关变更即失效，查库异常时 fail-open（不让门禁自身把面板拖垮）
- 接口：公开 `GET /api/system/instance`；管理员 `GET/POST /system/domains(/:kind)`、`PATCH/DELETE /system/domains/:kind/:id`、`POST .../verify`、`POST .../primary`、`GET/PUT /system/subscription-platforms`、`PUT /system/domain-restriction`；用户侧 `GET /api/account/subscription-platforms`（仅已启用、按序）

### 链接生成改造

- 订阅链接（delivery view，管理员与用户共用）：一律用主订阅域名 origin 生成；无可用主域名时 links 为空并返回 `linkError: 'SUBSCRIPTION_DOMAIN_NOT_CONFIGURED'` 供前端提示，**不回退请求 Host**；链接域名查询 fail-soft（未应用 0007 的旧库不至于 500）
- 分享链接：create/reset-token/meta 响应新增 `linkBaseUrl`（主订阅域名 origin，可为 null）；前端 `readPublicBaseUrl` 优先读 linkBaseUrl，`SharePage` 把 meta 的 linkBaseUrl 传给 `buildShareExportUrl`，客户端导入链接随之走主订阅域名；服务端 reveal 与 export(type=link) 的原始订阅链接改为「主订阅域名 > 分享设置 publicBaseUrl > 请求 Origin」优先级
- 面板链接：邀请链接改用主面板域名，无主面板域名时回退请求 Origin（简报允许的唯一回退）；**邮件模板经核查只含验证码、不含任何链接**，无邮件侧改动
- 备用订阅域名不出现在任何用户侧响应中（用户侧平台接口只回平台键与展示名；链接只用主域名）

### 前端

- 系统设置页新增独立分区组件 `DomainSettingsSection`（SystemPage 仅加 import＋一行渲染）：顶部域名限制开关＋后果说明、订阅平台展示（开关＋上/下移、即时保存全量）、面板/订阅域名双列表卡（添加、备注编辑、验证、设为主、启停、删除，主域名前端先拦＋服务端 409 兜底，状态徽章与最近验证时间/错误）
- 用户订阅页与首页主链接按平台设置过滤与排序（auto 优先→订阅默认客户端→首个可见条目）；`linkError` 时显示「订阅域名尚未配置」提示；平台全关时链接区显示「当前暂无可用的订阅入口」；平台接口拉取失败时**回退为不过滤**（展示开关不是安全边界，服务端订阅生成与权限校验未动）

## 合并注意事项（给父代理）

- d1.ts 测试基建：applyMigrations 末尾追加 0007，D1_TABLES 字母序插入三张新表；d1-foundation 迁移名清单末尾加 `0007_domain_stage`、重放计数 5→6。**APP 阶段（0006）合并时须把 0006 排在 0005 与 0007 之间**，foundation 断言与计数同步调整
- `src/styles/pages-system.css` 末尾追加了 `dom-` 前缀样式（APP 阶段若同改此文件，注意尾部追加冲突）
- `worker/app.ts` 新增 `app.use('*', hostGate)`（originGuard/noStore 之后）与三处 route 挂载（adminDomainRoutes、userDomainRoutes、publicSystemRoutes）
- 生产上线需应用 0007 迁移；应用后现网主域名即刻生效（种子已 verified＋主域名），域名限制默认关、不改变现网行为

## 出站纪律自查

除管理员手动触发的单次域名验证外，本阶段没有新增任何出站请求；验证零重试、5 秒超时、不带凭据、不碰订阅内容；平台与域名配置全部存在 D1，无新增定时任务
