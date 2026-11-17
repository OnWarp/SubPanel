# 管理员直改邮箱交付报告

## 改动与语义

- 扩展现有 `PATCH /api/admin/users/:id`，沿用管理员守卫、响应与错误信封、管理员审计中间件，不新增路由
- 用户管理表格新增所有活动账户均可使用的编辑入口，编辑弹窗复用现有 Dialog、FormField、form-stack 与按钮样式，预填当前邮箱，提交后刷新列表；不显示验证码输入
- 使用现有邮箱格式校验和 trim/lowercase 规范化；格式错误返回 422，其他账户当前邮箱冲突返回 409 / EMAIL_TAKEN，包含回收站账户；数据库唯一索引处理并发冲突
- **不查询注册邮箱域名白名单**，也不将其他账户尚未完成的验证码申请视为邮箱占用；这两项都不限制管理员直改
- 新邮箱和已验证时间立即写入 D1，新地址立即可登录，旧地址立即失效；不发验证码、不发确认邮件
- 邮箱、同时提交的角色/状态修改及目标账户未消费的验证码与历史改邮箱请求清理放在同一个 D1 原子批次，避免遗留验证码覆盖管理员设置
- 邮箱本身不改变角色、密码、会话版本、权益或订阅；角色/状态变更继续采用原有会话失效规则和最后管理员保护；允许最后管理员修改自己邮箱，允许同邮箱正常保存
- 邮箱与现有绑定/自助更换流程一致存储在 D1；尚未启用 D1 的旧 KV 模式返回 EMAIL_CHANGE_UNAVAILABLE，不静默丢弃邮箱；用户自助验证码实现未修改，已删除账户仍沿用先恢复再编辑规则
- 成功编辑由原有审计中间件记录 patch.users、操作者和目标 ID，不新增邮箱明文审计字段

## 检查与测试

- `npm run check`：通过（wrangler types --check、tsc、oxlint）
- `npm run build`：通过；仅现有体积级别的 >500 kB chunk 提示
- `npx vitest run --config development/vitest-pages-node.config.ts`：10 个文件、95 项全部通过
- `node development/test-admin-email-offline.mjs`：1 项综合 SQLite + 实际 Hono HTTP 集成测试通过，覆盖普通用户/其他管理员/自己/同邮箱、即时登录及旧邮箱失效、403、重复、格式、角色等字段保持、实际白名单绕过、其他账户 pending 验证码不阻挡、审计和零邮件发送
- `node development/test-pages-offline.mjs`：现有 3 项集成测试全部通过
- `git diff --check`：通过
- 现有 Worker 测试未删除，`d1-admin-users.test.ts` 新增 5 项，覆盖成功、权限、重复（含已删除账户）、格式及邮箱登录等要求
- `npm test` 和聚焦 `npm test -- development/tests/worker/d1-admin-users.test.ts` 均已尝试，但 workerd 启动被沙箱 `listen EPERM 127.0.0.1` 阻挡，未执行 Worker 断言；集成环境需复跑全量 Worker 测试，不能将上述替代测试视为全量 Worker 通过
- 初始 node_modules 符号链接目标只读，导致 Vite/TypeScript 缓存写入失败；将依赖复制到 /tmp 可写目录后重新运行检查与构建，未改依赖版本或 lockfile

## 提交与交付

原工作树 `.git` 只读，逐文件 git add 遭遇 index.lock 写入失败；依照 brief，在 `/tmp/admin-email-edit-repo` 可写克隆的同名分支 `task/admin-email-edit-codex` 提交实现、测试和本报告，原工作树保留相同源码与报告供审阅

从该克隆生成 `/tmp/admin-email-edit.bundle`，包含同名分支及提交历史，可用 git bundle verify 验证；没有 push 或 scp，未使用 git add -A
