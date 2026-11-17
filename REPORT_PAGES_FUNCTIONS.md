# 页面功能交付报告

## 审计结论

先完成 `AUDIT_PAGES.md`，枚举 `src/app/router.tsx` 的全部 34 个路由（含入口、别名和兜底），从页面操作处理器追踪到鉴权、API、service 与持久化。发现 4 类代码缺口，涉及 5 个页面；没有发现纯壳页面。其余完整结论属于源码核对，不代表逐页浏览器实测

## 已补全

| 审计项 | 实施结果 | 验证 |
|---|---|---|
| G1 计划目录 | `GET /api/account/plans` 沿用 account 鉴权，只读；SQL 仅查询启用计划，按管理排序返回；显式白名单仅返回 id/name/description/durationDays/trafficGb/speedLimitMbps/deviceLimit，不泄露 groupIds、管理状态、排序及时间字段；既有权益计划墙读取目录，无权益用户也可查看；保留当前/最近停用计划的已有展示 | 新增标准 Worker 用例及离线 HTTP 用例，检查未登录、普通用户、字段白名单、排序、停用/删除即时生效和不可写 |
| G2 公告搜索/分页 | `/api/notices?q=&page=&pageSize=` 使用 D1 查询匹配标题/正文、总数与分页；仅可见公告，保持既有排序；绑定参数，`%`、`_` 与 SQL 标点按字面匹配；无参数调用继续返回完整可见列表以兼容首页轮播；页面使用服务端结果，序列保护避免旧响应覆盖新搜索 | 标准 Worker 用例与离线 HTTP 覆盖标题/正文、中文、大小写、隐藏公告、空搜索、越界、参数上限、字面标点和发布/删除后结果变化 |
| G3 概览统计 | 用户总数、有效权益、7日到期、待处理工单以及资源区用户数统一读取 `/api/admin/stats`；移除所有逐页用户及逐用户权益统计请求和额外工单计数请求；沿用服务端启用用户/启用计划/到期边界口径 | 新增离线 stats 路由鉴权/响应检查；已有 stage3 离线测试覆盖启用账户/计划、精确权益时间窗口 |
| G4 用户选择器截断 | 共享 `loadAdminUserOptions` 每次请求100人并遍历至 total；订阅所属用户选择和管理分享用户筛选使用完整结果；遇到空的不完整分页显式失败，避免静默截断和无限循环 | 前端测试覆盖205用户跨3页及异常空页 |

没有修改 CSS、主题令牌或路由，没有新增页面；复用原有组件与布局。没有数据库结构变化，无需新增迁移

## 剩余事项与限制

- G5 自动到期邮件提醒仍受平台 cron 触发器权限阻塞，按 brief 不改 cron。手动发送端点、提前天数设置和已有页面提示保持可用
- 标准 Worker 全量测试尚未验证，不能声称基线406测试全部通过或证明全量无回退；合入环境应运行 `npm test`，包含新增计划目录、公告查询和用户分页用例
- 浏览器端到端测试未运行，当前沙箱禁止 localhost socket；页面连接由源码追踪与端点/客户端测试验证

## 检查结果

| 命令 | 结果 |
|---|---|
| `XDG_CONFIG_HOME=/tmp/pages-xdg npm run check` | 通过，Wrangler 类型一致、TypeScript 与 oxlint 通过 |
| `XDG_CONFIG_HOME=/tmp/pages-xdg npm run build` | 通过；仅已有类型的产物超过500kB提示 |
| `npm test`（设置上述 XDG 路径） | Worker 启动被 `listen EPERM: operation not permitted 127.0.0.1` 阻断，未执行测试 |
| `npx vitest run --config development/vitest-pages-node.config.ts` | 10文件、95测试通过，包括前端 API 的5测试 |
| `node development/test-pages-offline.mjs` | 3测试通过，真实 Hono 路由 + SQLite 的计划/公告/stats 检查 |
| `node development/test-stage3-offline.mjs` | 7测试通过，含统计口径、审计、邮件及提醒 |
| `node development/test-entitlements-offline.mjs` | 10测试通过，含权益状态、订阅授权及试用事务 |
| `git diff --check` | 通过 |

通过的独立用例总数115，前端5项已包含在95项内，不重复计数。离线测试使用 SQLite/D1适配及进程内请求，不能替代 workerd 集成复验。最初探索扩大 Node 子集时，7个文件因间接依赖 `cloudflare:workers` 无法加载；最终提交的 Node 配置只包含可独立运行的10文件，没有改动标准 Worker 配置或删减既有测试

沙箱的共享 node_modules 符号链接目标只读，最初运行还遇到 TypeScript/.vite-temp 缓存写入失败。验证时临时将符号链接指向 `/tmp/pages-node-modules`，该目录复用原依赖且缓存可写，并将 Wrangler 配置/日志定向到 `/tmp/pages-xdg`。检查完成后恢复原 node_modules 符号链接；没有提交任何依赖、构建缓存或环境配置改动

## 提交与 bundle

原工作区 `.git` 被挂载为只读，实际 `git add`/`git commit` 报 `Unable to create .../.git/index.lock: Read-only file system`，无法更新该工作区的索引和分支引用。未请求权限或更改受限元数据，使用本地可写克隆 `/tmp/pages-functionality-delivery`，在相同分支 `task/pages-functionality-codex` 提交所有实现和审计

实现提交：`7a52457`（Complete page functionality for plans notices statistics and user selectors）。本报告随后单独提交，同一分支的最终 bundle 包含两个提交

交付文件：`/tmp/pages-functionality.bundle`，由该可写克隆执行 `git bundle create /tmp/pages-functionality.bundle task/pages-functionality-codex` 生成，并用 `git bundle verify` 及分支引用核对验证。没有 push/scp。原工作区保留全部源文件修改与本报告，其只读分支引用仍在原提交；接收方应从 bundle 获取最终分支

所有文件均逐项暂存，没有使用 `git add -A`。原有未跟踪输入文件 `BRIEF_PAGES_FUNCTIONALITY.md` 未纳入提交
