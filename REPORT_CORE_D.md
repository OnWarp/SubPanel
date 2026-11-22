# SubPanel 阶段 D 交付报告

## 基线核查

- 工作目录为 `/data/workspace/subpanel-core-d`，交付分支为 `task/core-d-conversion`
- 开工核对 Git 身份为 `Muse <muse@outtw.com>`，分支起点、`origin/main` 和合并基点均为 `8a17f0aab5a2842aea1e09f33e8268ebac10f6f3`。本线未 rebase、未合 main
- 计划原路径在本机缺失，使用同名计划的工作区副本 `/data/workspace/PLAN_CORE.md`，核对 §4 与 §13 第 5、6 项。工作区原有的未跟踪简报 `BRIEF_CORE_D.md` 留在本地
- 在基线独立工作树重跑控件套件，实测 35 通过、1 失败。该断言仍依赖 `8a17f0a` 已删除的重复订阅标题，随本线改为检查现行单标题、可访问列表、搜索、添加入口和分页

## CORE-05 · Mihomo 模板增强

- Mihomo 基础输出和已发布策略均生成 `mode: rule`、`proxies`、`proxy-groups` 和 `rules`。策略组支持手动选择、URL 测速、故障转移、负载均衡。校验组成员、重复名称、循环引用、规则目标、规则集、`no-resolve` 和末尾 `MATCH`，按源规则顺序下发
- Mihomo 源码的 `subpanel.nodes` 支持前后缀、受限正则重命名和排除、名称排序和去重。正则允许字符、字符类和锚点。节点转换复用客户端协议和字段兼容诊断。`subpanel.client` 提供 DNS、TUN、规则模式、代理端口、嗅探、GeoData、IPv6 和日志等级。策略和规则使用原生 Mihomo 段
- 管理员可编辑草稿、用真实授权订阅或合成节点预览、校验、查看与当前发布 YAML 的差异，再发布。可用已发布版本验证指定订阅。实际灰度使用现有的复制配置和指定绑定，仅让测试订阅先收到副本。历史版本可独立预览或回退
- 用户端保留平台切换、配置类型标识和导入指引。Mihomo 格式明确提醒用户导入后检查规则模式，部分客户端会保留本地设置

## CORE-06 · 转换中心与兼容性

- `0020_conversion_profiles.sql` 增加通用 profile、平台版本、绑定模型以及规则库。旧 Mihomo 模板表仍持有草稿、已发布指针和修订号。迁移回填同一 ID，触发器自动关联之后的新模板和版本，统一视图投影同一份版本和绑定，避免两处分别维护
- 旧绑定 `inherit/specific/base` 继续使用原来的继承、指定、基础语义。历史版本按旧字段范围解释。既有链接、Token 和授权范围沿用订阅链路，下发内容仍须通过模板和节点校验
- 管理员在「订阅管理 → 转换配置」中查看状态、平台、最近发布与绑定订阅数，并在表单和高级 YAML 模式间切换。系统设置的模板入口及历史编辑链接指向转换配置。订阅详情可打开当前发布版本的预览和诊断
- 预览显示输入、授权、输出、跳过、协议及字段诊断、格式和引用错误、具体配置版本、渲染器版本及输出摘要。真实订阅样本展示脱敏配置，合成样本可查看完整结构。渲染器版本为 `3`
- 规则库提供系统私网规则、带修订号的管理员自建规则，以及管理员手动触发的远程规则源。自建规则插入草稿，随发布版本保留。远程规则源仅接受公用白名单 HTTPS 域名，禁用重定向、查询参数和片段，单次上限 7 秒、256 KiB、10,000 条、平坦 YAML 数组或文本。`ETag` 与 `Last-Modified` 用于条件请求，失败保留最近成功的内容和版本并记录错误。新发布的引用需要七天内的成功校验，发布本身不触发网络下载。远程引用由客户端按 Mihomo 原生方式读取，因此远程 URL 的内容变化仍受上游控制
- 现有远程模板导入继续使用管理员单次抓取入口。远程规则测试使用模拟响应覆盖条件请求、私网拒绝、跳转拒绝和保留历史成功记录

## 迁移与回滚

本线只在隔离本地 D1 上应用迁移。全新库按顺序应用了仓库全部 19 个迁移，包括 0020。Worker 测试验证了带历史模板、绑定及发布指针的迁移。生产由集成方备份后单次执行 `wrangler d1 execute --file` 并回查，生产迁移台账为空，不适用全量 `migrations apply --remote`

配置问题可先经版本历史回退。若需降级整个 Worker，应在仍运行阶段 D 的版本上先把使用新增语法的 Mihomo 配置切到旧版可解析的历史发布版本。没有可用历史版本的配置可以先通过默认设置或绑定切回基础配置，再部署旧 Worker。数据库附加结构可暂留。若还需撤回 schema，先备份新表，删除 `conversion_link_version`、`conversion_link_template` 两个触发器，删除 `conversion_effective_bindings`、`conversion_profile_outputs`、`conversion_profile_catalog` 三个视图，再依次删除绑定、平台版本、profile 及两张规则库新表，并与生产实际迁移记录核对。含历史数据的 SQLite 副本已执行逆向删除，旧模板、版本、默认配置与绑定全部逐行一致，外键检查通过

## 验证结果

| 项目 | 实测 |
| --- | --- |
| `npm run check` | 0 错误 |
| `npm run build -- --outDir /data/tmp/core-d/dist` | 通过，构建仍提示部分代码块超过 500 kB |
| Worker | 531 项通过，含既有 528 项及 3 项新增覆盖 |
| 页面、控件、订阅、模板 | 228、36、14、93 项通过 |
| 六支指定浏览器回归脚本 | `test-mobile-bar-inset`、`test-layout-switch-split`、`test-design-v2-p3`、`test-home-traffic`、`test-core-b-screenshots`、`test-core-c` 全部通过 |
| `development/test-core-d.mjs` | 使用真实本地 Worker 与 D1，1440 px 和 390 px 通过。验证管理与用户导航、规则库、发布差异、指定版本预览、发布和回滚 |
| Mihomo 原生校验 | v1.19.30 执行 `mihomo -t` 通过。样例由公开订阅端点生成，使用合成节点及凭据 [官方发布](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.30) |

[实际 Mihomo 输出样例](development/verification/core-d-mihomo.yaml) · [截图目录](development/screenshots/core-d/)

| 截图 | 1440 px | 390 px |
| --- | --- | --- |
| 配置列表 | [桌面](development/screenshots/core-d/profiles-1440.png) | [移动](development/screenshots/core-d/profiles-390.png) |
| 规则库 | [桌面](development/screenshots/core-d/rule-library-1440.png) | [移动](development/screenshots/core-d/rule-library-390.png) |
| 基础编辑器 | [桌面](development/screenshots/core-d/editor-1440.png) | [移动](development/screenshots/core-d/editor-390.png) |
| 发布差异 | [桌面](development/screenshots/core-d/publish-1440.png) | [移动](development/screenshots/core-d/publish-390.png) |
| 版本预览与诊断 | [桌面](development/screenshots/core-d/preview-1440.png) | [移动](development/screenshots/core-d/preview-390.png) |
| 管理员订阅详情 | [桌面](development/screenshots/core-d/subscription-details-1440.png) | [移动](development/screenshots/core-d/subscription-details-390.png) |
| 系统模板兼容入口 | [桌面](development/screenshots/core-d/settings-1440.png) | [移动](development/screenshots/core-d/settings-390.png) |
| 用户平台及导入提示 | [桌面](development/screenshots/core-d/user-formats-1440.png) | [移动](development/screenshots/core-d/user-formats-390.png) |

## 后续阶段

- **CORE-07** 接续 sing-box 完整编译、目标版本字段验证和客户端导入测试。阶段 D 预留了原生 `outbounds`、`route`、`dns` 及可选 `route.rule_set` 的 JSON 结构与目标版本字段。sing-box、Surge、Loon、Quantumult X 暂仅提供节点订阅
- **CORE-08** 接续受影响订阅的增量失效及批量编译任务化
- 交付 bundle 位于 `/data/tmp/core-d-conversion.bundle`

GROK_CORE_D_DONE
