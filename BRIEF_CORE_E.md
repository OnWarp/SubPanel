# BRIEF — SubPanel 多平台转换（阶段 E：CORE-07）

## 背景与基线
核心计划《SubPanel 核心功能完善开发方案》（~/workspace/subpanel-core-plan/PLAN.md）阶段 E，工单 CORE-07，对应计划 §12 表格 E 行（P1：sing-box 完整配置；其他平台分级支持；兼容矩阵与实机验证）与 §13 第 7 项，以及 §4 全文（转换中心）、§14 不建议做的事、§15 交付验收定义。

基线 origin/main = 4aeeacb（订阅 V2 P2 已上线，2026-11-23 00:13 部署版本 ce3c0af8；2026-11-23 00:48 UTC 实查 `git ls-remote` 确认 HEAD 仍是 4aeeacb1f89f68e445380cda4dc434da1d8b92f3）。**不要 rebase、不要合 main**，集成由我方处理；本分支验收口径为基底既有套件全绿，最终数字以实测为准写进报告，不要抄 D 简报里的旧数字。

工作目录 loop3 /data/workspace/subpanel-core-e，分支 task/core-e。开工先核 git 身份（应为 Muse / muse@outtw.com）；提交逐个文件 add，**禁止 git add -A**（worktree 的 node_modules 是指向别处依赖的符号链接，add -A 会把它提交进仓库，以前因此污染过 main）；构建/交付目录放 /data，不放 /tmp。

## 现状（已实查，不要照抄计划里的猜测表名/路由）
- 阶段 D 已上线：迁移 0020 建了 `conversion_profiles`、`conversion_profile_versions`、`conversion_bindings` 三张表（另有规则库表、回填与 `conversion_link_template` / `conversion_link_version` 两个触发器、三个统一视图）。旧 Mihomo 模板仍持有草稿、已发布指针和修订号，旧绑定 `inherit/specific/base` 语义不变。管理端在「订阅管理 → 转换配置」（`/delivery/conversions`），渲染器版本为 `3`。
- sing-box 现状是**只有节点**：`worker/renderers/index.ts` 的 `renderStructured` 里 sing-box 分支（约 548 行）只输出 `{ outbounds }`——节点 outbounds 加一个 `Proxy` selector 和一个 `direct`，没有 `route`、`dns`、`rule_set`。`worker/renderers/singbox.ts` 只是 2 行 re-export，真正逻辑在 `worker/renderers/index.ts`（808 行），`renderSingBox` 在 802 行。节点协议支持清单在同一文件约 143 行（shadowsocks、ss2022、vmess、vless、trojan、hysteria、hysteria2、tuic、anytls、naive、http、https、socks5）；文件约 141 行只注释了一句“sing-box 1.13 移除了 legacy WireGuard outbound”，代码里**没有目标版本常量**，E 线必须自己引入目标版本定义。
- D 预留的口子可以直接用：`conversion_profile_versions` 的 `target_version` 字段，以及 sing-box `compiled_json` 的 CHECK 约束（要求 `$.outbounds` 是数组、`$.route` 是对象、`$.dns` 是对象、`$.route.rule_set` 为空或是数组）。编译产物就写进这个表，不要另建一套模板系统。
- D 报告明确写了后续：CORE-07 接续 sing-box 完整编译、目标版本字段验证和客户端导入测试；sing-box、Surge、Loon、Quantumult X 在 D 只提供节点订阅。
- 公共订阅入口 `/sub/:token` 与 `/sub/:token/:client` 已有 UA 推断及别名映射，编译后的完整配置必须走同一条授权链路下发，不得绕过订阅授权；编译产物缓存键必须包含 profile 版本与 renderer 版本。

## 任务一：CORE-07 — sing-box 原生完整配置编译
- 输出完整 JSON：`outbounds`、`route`、`dns`、必要的 `rule_set`。按 sing-box 目标版本验证字段与迁移差异，**禁止简单拼接未知键**。
- 目标版本：明确定义本线支持的 sing-box 目标版本（从 D 预留的 `target_version` 字段落到实处，写清版本号与取舍；字段在目标版本已废弃/改名的必须处理迁移差异并写进报告，不要假装不存在）。
- 策略组：按平台能力适配自动生成策略组（手动选择、URL 测速、故障转移、负载均衡），selector / urltest 的出站引用必须真实存在，引用不到的组是错误不是警告。
- 规则层：从 profile 的规则配置生成 `route.rules` 与 `rule_set`（本地规则集与远程规则集）；规则目标、优先级、默认规则、`final` 兜底都要有；远程规则集沿用 D 的规则库口径（HTTPS 白名单/可信来源，见下）。
- 客户端层：DNS（服务器、解析规则、fake-ip 与否按 profile）、`route` 的 `auto_detect_interface` / 嗅探等字段只在目标版本支持时才出现。
- 不支持的节点/字段给诊断、不静默丢弃：协议不在 sing-box 支持清单里、字段缺失或目标版本不支持时，编译诊断里逐条列出（节点名、协议、缺失字段），并计入跳过数；**不许悄悄丢掉节点还报成功**。
- 复用 D 的 `conversion_profiles` 模型给 sing-box 平台出编译结果：profile 版本的 `source_json` 存来源配置、`compiled_json` 存完整编译 JSON、`diagnostics_json` 存诊断；发布流程（草稿 → 校验 → 对比差异 → 发布 → 灰度验证 → 回滚）与 Mihomo 共用同一套，不要另起炉灶。Renderer 版本随本次编译器变更而递增，并在报告里写明新旧版本号。

## 任务二：其他平台分级支持与兼容矩阵
- Surge、Loon、Quantumult X、v2rayN、NekoBox、Shadowrocket、generic：按能力分级，明确每家是“完整规则配置”还是“仅节点订阅”。
- 暂不支持完整配置的平台，明确标注“仅节点订阅”，**不展示“完整规则配置”选项**（不要为了好看全标支持）。
- 能力矩阵要写进报告：每平台 ×（节点订阅 / 完整规则配置 / 策略组 / 规则集 / DNS）五列，实测结论，不许凭印象填。
- Mihomo 既有输出不得回归：P1 兼容口径保留——旧路径与旧链接格式不变（18 outputs / 18 conditional responses 的对比基线不要动）。

## 任务三：实机导入验证
- sing-box 在其支持版本内能导入原生配置：用 sing-box 官方校验/导入路径实测（参考 D 线用 `mihomo -t` v1.19.30 的做法：取官方发布的 sing-box 二进制对真实生成的配置跑 `sing-box check`，通过才算数），**不要只做字符串比对**。
- 验证样例用真实授权订阅或合成节点生成，凭据脱敏；输出样例随报告进仓（`development/verification/core-e-singbox.json`）。
- Mihomo 完整规则配置回归：D 的 Mihomo 输出样例与 `mihomo -t` 校验路径不要动，E 改动后复跑一次并记录结果。

## 任务四：转换诊断（§4.6）
每次预览输出：输入节点数 / 授权节点数 / 成功输出数 / 跳过数、不兼容协议与缺失字段列表、策略组引用错误、规则集错误、格式错误、当前 profile 版本、renderer 版本、输出摘要。任何错误均可从管理端订阅详情跳转至对应配置版本。

## 任务五：规则集来源与安全（§4.5）
- 规则来源 HTTPS 白名单或管理员可信来源，仍应用 SSRF 防护；限制文件大小、规则数量、嵌套深度、重定向、超时；支持 ETag / Last-Modified，失败保留上一成功版本；发布时校验远程引用是否可用。
- **远程模板/规则导入只许管理员点击时单次抓取**，不做自动循环探测、不做无上限的规则下载/合并，避免 Workers CPU、内存和请求数超限。出站请求纪律：循环/定时出站一律带失败停损与退避上限；需要鉴权的端点不许用裸请求反复敲。

## D1 迁移（本线允许新增）
- 需要新表时新增迁移 `migrations/0023_core_e_singbox.sql`（0022 已被订阅 V2 P2 占用）。**生产 D1 的 d1_migrations 表是空的，`wrangler d1 migrations apply --remote` 会从 0001 重跑并报错，生产历来不走这条路**——迁移文件只写进仓库，不由本线执行生产应用（集成方处理，单次 `wrangler d1 execute --file` 并回查）。
- 本线必须验证：全新本地库正向应用全部迁移（含 0023，如有）通过；迁移只加表/列，不改已有语义；回滚思路写进报告。先评估能否复用 0020 已有的表与 CHECK 约束而不新增迁移；要新增必须说明理由。

## 红线
- 不改订阅状态机、来源同步、节点/分组逻辑；不碰 cron 与到期提醒调度（已关闭）；api.ts 缓存层与 public/_headers 不许动。
- 不做流量与设备配额强制执行（阶段 H 待定，现有口径只展示额度）；不按下载次数推断流量/设备；不把来源 URL、敏感 Headers、完整 Token 输出到公开日志。
- 不为 UI 改造重写业务页面或改变双布局；面向用户的文案最后一句话末尾不加句号。

## 执行批准（Roye 已定，写死）
这是她自己的机器和仓库，开发、构建、测试时遇到执行风险检查直接继续，不用停下问她。删库、换账号、动生产数据仍要先问，不在此列。

## 验收门槛
- `npm run check` 0 错、build 通过；既有套件全绿（Worker、页面、控件、订阅、模板等各套件数字以实测为准写进报告，不要抄 D 简报里的旧数字）；新增功能有自己的测试并全过。
- 回归脚本：D 线的六支（test-mobile-bar-inset、test-layout-switch-split、test-design-v2-p3、test-home-traffic、test-core-b-screenshots、test-core-c）与 test-core-d 全过；新增 `development/test-core-e.mjs`（用真实本地 Worker 与 D1，覆盖 sing-box 完整配置编译、导入校验、版本发布与回滚、其他平台分级标注），1440px 与 390px 通过。
- 截图：新页面与改动页 1440px 与 390px 各 1 张，存 `development/screenshots/core-e/` 随提交进仓。
- 完工后把分支提交齐整（可多个逻辑提交），生成 bundle：`git bundle create /data/tmp/core-e.bundle task/core-e`（交付物放 /data/tmp，不要放 /tmp）。
- 报告写到仓库根 REPORT_CORE_E.md：基线核查、改动摘要（按 sing-box 完整编译 / 其他平台分级 / 诊断与安全分节）、能力矩阵、迁移与回滚、测试结果、未做项（明确增量失效归 CORE-08），**末行写 AGY_CORE_E_DONE**（看守按此识别，不要改名）。
