# SubPanel 阶段 E 交付报告 · CORE-07

## 基线核查

- 分支为 `task/core-e`，沿用 WIP `6f258c7`，父提交为简报指定的 `4aeeacb1f89f68e445380cda4dc434da1d8b92f3`。Git 身份为 `Muse <muse@outtw.com>`，提交历史保持原顺序
- 本机 `origin` 指向续跑输入 bundle，基线通过本地 Git 提交与独立工作树复核。计划原路径缺失，复核工作区副本 `/data/workspace/PLAN_CORE.md` 的 §4、§12 E 行与 §13 第 7 项

## sing-box 完整编译

- 目标版本为 sing-box `1.14`，用官方 Linux amd64 `1.14.4` 校验。渲染器版本由 `3` 升至 `4`。发布时在原子批次中把来源、合成节点的完整编译结果及诊断写入 0020 的 `conversion_profile_versions`。实际订阅下发使用该版本固定的规则集与订阅当前授权节点，组合 `outbounds`、`route`、`dns` 和所需的 `route.rule_set`
- 转换配置编辑器沿用现有草稿、校验、差异、发布、灰度和回滚。发布对话框可勾选同时发布 sing-box，已发布 sing-box 的配置会默认保留该选项。管理员可复制配置并指定绑定到灰度订阅。无 sing-box 发布版本时，原链接继续提供基础节点输出
- 策略组使用 `selector` 和 `urltest`。故障转移与负载均衡都降级为延迟选路，并在发布版本和预览中显示适配诊断。组名冲突、未知组和未知规则目标会报错。普通规则依照源码顺序执行，`MATCH` 映射到 `route.final`，sing-box 专用规则集按本地、远程的顺序先于普通规则
- 将嗅探和 DNS 劫持写成路由动作，使用结构化 DNS server、`route.default_domain_resolver` 及类型为 `fakeip` 的 DNS server。高级 YAML 可配置 `subpanel.singbox.fakeIp`、`dnsRules`、`sniff`、`autoDetectInterface`。`dnsRules` 用 `domainSuffix` 和 `resolver: local|remote` 指定按域名后缀解析的顺序，优先于 FakeIP 兜底。远端 DNS 使用共享 DNS 配置的首个服务器，支持 HTTPS 或 UDP 主机名
- WireGuard 旧 outbound 自 1.13 移除，归入协议跳过诊断。GeoIP、Geosite 等旧匹配表达式需替换为规则集或显式匹配。客户端专属设置按明确的 sing-box 字段映射输出 [官方迁移说明](https://sing-box.sagernet.org/migration/) · [FakeIP](https://sing-box.sagernet.org/configuration/dns/server/fakeip/)

## 平台分级

| 平台 | 节点订阅 | 完整规则配置 | 策略组 | 规则集 | DNS |
| --- | --- | --- | --- | --- | --- |
| Mihomo | 通过 | 通过 | 手动、测速、故障转移、负载均衡 | 原生 provider 路径 | 原生 DNS |
| sing-box 1.14 | 通过 | 勾选发布后通过 | 手动、测速。故障转移和负载均衡适配为测速 | 本地内联、已验证 YAML/文本快照、固定提交原生远程 JSON | HTTPS/UDP、域名后缀规则、可选 FakeIP |
| Surge | 通过 | — | 基础输出中的固定 Proxy 选择组 | — | — |
| Loon | 通过 | — | — | — | — |
| Quantumult X | 通过 | — | — | — | — |
| v2rayN | 通过 | — | — | — | — |
| NekoBox | 通过 | — | — | — | — |
| Shadowrocket | 通过 | — | — | — | — |
| generic | 通过 | — | — | — | — |

节点订阅结果以真实本地 Worker 下发和预览为准。完整配置另经官方内核校验。管理端预览选项、订阅详情和用户侧客户端列表按实际下发能力标注。别名和 UA 自动识别复用原授权链路。未配置完整策略的九个 renderer 在两组基线输入上的 18 个输出与基底逐字节相同，HTTP 回归另覆盖 18 个客户端路径的下载及对应 18 次条件请求 `304`

## 诊断与规则源安全

- 预览展示输入、授权、输出、跳过、协议/字段、规则或策略引用、格式错误、配置版本、渲染器版本和输出摘要。订阅详情按所选客户端跳转到生效版本。真实订阅预览中节点仅保留标签、类型及策略组成员，合成样本用于查看完整结构
- 管理员通过 `subpanel.singbox.localRuleSets` 的 `name`、`outbound` 引用规则库中的本地规则。共享 YAML/文本远程 provider 在发布时转换为有上限的内联快照。通过 `subpanel.singbox.remoteRuleSets` 的 `name`、`outbound`、`url` 可引用经验证且固定 Git 提交的原生 JSON。规则库抓取该格式时选择经典规则和文本 [官方规则集格式](https://sing-box.sagernet.org/configuration/rule-set/)
- 规则库沿用 HTTPS 白名单、SSRF 校验、禁止重定向、7 秒超时、256 KiB 文件和 10,000 条上限。原生 JSON 限定平坦的域名或 IP 匹配字段，拒绝逻辑嵌套。管理员单次抓取使用 ETag/Last-Modified，失败保留上次成功版本。发布需要近七天的有效验证记录。发布、预览及订阅请求读取 D1，原生远程规则集由客户端获取
- 缓存以订阅 Token 哈希、客户端、profile 版本及 renderer 版本区分。有效订阅授权和响应内容按实时状态生成，旧缓存键保留兼容性

## 迁移与回滚

复用 `0020_conversion_profiles.sql` 的版本表、约束和发布指针，因此无需 0023。全新隔离本地 D1 正向应用现有全部 21 个迁移至 0022，随后启用本地模块并运行浏览器验证。生产部署和数据操作交由集成方

从版本历史回退会同时恢复该版本的 Mihomo 与 sing-box 能力和输出。可通过基础绑定恢复基础下发。若回退 Worker 代码，0020 结构与历史版本可以保留，基底 Worker 仍沿用原 Mihomo 指针和绑定

## 验收实测

| 项目 | 实测 |
| --- | --- |
| `npm run check` | 通过，0 错误 |
| `npm run build` | 通过，Vite 有代码块超过 500 kB 的提示 |
| Worker | 63 个文件，544 项通过 |
| 页面、控件、订阅、模板 | 分别 228、36、14、93 项通过 |
| 浏览器回归 | `test-mobile-bar-inset`、`test-layout-switch-split`、`test-design-v2-p3`、`test-home-traffic`、`test-core-b-screenshots`、`test-core-c`、`test-core-d` 全部通过 |
| `development/test-core-e.mjs` | 真实本地 Worker 与 D1 在 1440 px、390 px 通过。覆盖完整 JSON、内核校验、别名、UA、版本差异、两次发布、条件请求、回滚字节相同、分级和诊断跳转 |
| sing-box 官方内核 | `sing-box 1.14.4 check` 通过，样例来自授权本地订阅，使用合成节点和凭据 |
| Mihomo 官方内核 | `mihomo -t` 用 v1.19.30 和 v1.19.34 验证阶段 D 的样例通过 |

回归复跑修复了浏览器过期日期受机器时钟影响、P2 订阅向导缺少 mock 响应，以及离线模板夹具缺少 0020 的问题。独立基线重跑发现两条离线订阅断言仍假定池订阅拒绝空的 generic 输出及到期读取修改数据库，已按基线实际合同校验。产品状态逻辑沿用基底

- [sing-box 合成输出](development/verification/core-e-singbox.json) · [Mihomo 阶段 D 样例](development/verification/core-d-mihomo.yaml)
- [1440 px 与 390 px 截图](development/screenshots/core-e/)包括配置列表、规则库、发布差异、版本预览、订阅详情、用户格式列表。截图隐藏订阅链接与二维码

## 未做项

- 增量失效、受影响订阅识别与批量编译任务化归 CORE-08
- sing-box 针对 1.14 规范校验。其他客户端 GUI 的导入与连通测试超出本次内核和下发验证范围

AGY_CORE_E_DONE
