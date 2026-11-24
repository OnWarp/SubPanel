# 兑换码 12 位收敛

## 改动前审计

- 工作目录 `/data/workspace/subpanel-redemption-12`，分支 `task/sub-redemption-code-12`，HEAD 与本地 `origin/main` 同为 `bfdb8a625ac54e0656a3ab5fd80092ca960013e0`。提交身份 Muse / muse@outtw.com。`/data` 可用约 6,554 MB，使用率 68%。`node_modules` 为符号链接。
- `worker/redemption/credentials.ts` 使用 CSPRNG 拒绝采样，精确字符集为 `23456789ABCDEFGHJKMNPQRSTVWXYZ`，共 30 个字符。旧码 28 位全部随机，约 137.39 bit，码面校验部分为 0 bit。显示七组四位。输入上限 100 字符，删除全部空白和 ASCII 短横后转大写，再验证字符集和长度。
- `worker/redemption/service.ts` 在签发时计算完整 HMAC-SHA256（消息 `code:<canonical>`），兑换预览和确认按在线密钥版本计算摘要并查账，预览凭证和确认重放凭证各有独立 HMAC。`worker/redemption/routes.ts` 提供管理端签发、尾码及记录入口，以及 `/api/me/redemptions/preview` 和 `/api/me/redemptions`。单次事务负责扣次数、发订阅、记录与审计。
- `migrations/0023_subscription_v2_p3.sql` 将密钥版本、摘要、尾四位保存为 TEXT，摘要与版本联合唯一，无完整明文、码长 CHECK 或尾码长度 CHECK。管理页首次响应的只读文本框及 CSV 有完整码，批次详情和流水只展示尾码。原兑换码页无专用复制按钮。个人中心 `/me` 的兑换入口（含 `/me/redemption` 深链接）只有输入、预览、确认及历史，历史没有完整码。现有订阅链接复制按钮复制的是订阅 URL。
- 生产未兑现旧码数没有可靠证据。当前环境未发现 Cloudflare CLI 登录配置或 Cloudflare 凭据环境变量，仅找到本地 dry-run 的 0 条，不能当成生产统计。本阶段不访问生产 D1，按存在未兑现旧码保留兼容。基底全为旧格式，授权环境可按下列只读聚合取得变更前的「可用且从未兑换」与「仍有剩余额度」两个口径（不读取明文或单条记录）。

```sql
SELECT COUNT(CASE WHEN c.used_count = 0 THEN 1 END) AS unused_codes,
       COUNT(*) AS codes_with_remaining_uses,
       COALESCE(SUM(c.max_uses - c.used_count), 0) AS remaining_uses
FROM redemption_codes c JOIN redemption_batches b ON b.id = c.batch_id
WHERE b.enabled = 1 AND c.revoked = 0 AND c.used_count < c.max_uses
  AND b.redeem_deadline > unixepoch('subsec') * 1000;
```

## 新格式和校验

- 新码为 12 个字符，沿用 30 字符集 `23456789ABCDEFGHJKMNPQRSTVWXYZ`，显示、复制、CSV 均为 `XXXX-XXXX-XXXX`。个人中心输入允许 ASCII 大小写、首尾空白，以及紧凑或标准分组形式，离开输入框后整理成大写分组。非法字符、非标准分隔位置和新码内部空白均拒绝。旧码保留原归一化规则，完整旧码使用七组四位。个人中心历史只展示兑换结果；管理端历史仍只显示既有四位尾码。
- 前 10 位是独立均匀 CSPRNG 字符，约 49.07 bit；末 2 位为独立消息域 `redemption-short-tag` 的 HMAC-SHA256 拒绝采样结果，900 种标签，约 9.81 bit。标签对同一密钥和随机段是确定性的；独立随机熵为 49.07 bit。服务端按原先的无短横大写规范值计算完整 HMAC-SHA256 摘要和查账，然后用匹配行的签发密钥校验短码标签。未登记输入不会获得单独的标签正确反馈。28 位码仍直接走旧版摘要与查账路径，预览和确认凭证格式未改。
- D1 仍存 `digest_key_version`、完整摘要和末四位，完整码只在首次签发响应释放。保留 `REDEMPTION_HMAC_KEYS` 和已有轮换语义。旧码在其签发密钥仍保留、且符合原业务条件时可继续兑换。现有表结构即可容纳两种格式，无 0026 迁移。

## S05 应用层限流与风险

- 兑换预览与确认共用 D1 固定窗口。每账户 20 次/10 分钟、每来源 80 次/10 分钟、全局 1,200 次/分钟，另有全局失败阈值 300 次/分钟。失败阈值在后续请求入口读取，并发在途请求可能越过阈值，因此同时使用全局硬上限估算。以下按持续跑满、单张目标码始终有效、有放行账户且每次独立猜测的期望值计算。固定窗口允许边界突发。
- 对单张指定短码，未知尾码及密钥时，盲猜空间是 `30^12 ≈ 5.314 × 10^17`。按每分钟 300 次约需 33.7 亿年，按每分钟 1,200 次约需 8.42 亿年。攻击者获知四位尾码时，按剩余 8 位即 `30^8` 估算，分别约 4,158 年和 1,040 年。若只泄露签发密钥，标签即可计算，空间降至 `30^10`，分别约 374 万年和 93.6 万年。泄露密钥加摘要时可离线尝试，线上 D1 限流不能保护这类攻击。多个同时可兑换的目标会按有效目标数量近似缩短盲猜耗时。
- 相较旧版 137.39 bit 随机熵，短码的随机空间明显缩小。单批在签发前去重。同密钥版本的跨批碰撞由 D1 唯一约束挡住，事务整批回滚。跨版本同一完整码碰撞仍有极小概率，约为每对 `1/30^12`。密钥泄露、全局可兑换码规模和尾码可见范围都是实际安全边界。

## 改动与回滚

- `shared/redemption-code.ts` 集中维护字符集、归一化和分组。 `worker/redemption/credentials.ts` 负责生成和验证 HMAC 标签，`worker/redemption/service.ts` 接入签发与查账。
- `src/features/redemption/AdminRedemptionsPage.tsx` 的结果抽屉复用共享 `CopyButton`，复制与 CSV 使用同一批展示值。 `src/features/redemption/PersonalRedemptions.tsx` 复用共享格式函数，保留既有预览和确认流程。
- `development/tests/worker/subscription-v2-p3.test.ts` 覆盖两种码格式、错误标签、真实旧账本兼容与新码并发。 `development/test-sub-v2-p3.mjs` 扩展桌面和移动签发、复制和完整兑换路径。
- 若发布后需回滚，先核实是否曾签发短码。若从未签发，可直接回到基底构建。若已签发或无法确认，回滚版本须保留本次双格式归一化与校验，只将发码恢复成旧版 28 位 CSPRNG 与七组显示。保留账本和有效签发密钥，先在隔离环境验证两种已发码都能兑换，再由集成方发布回滚版本。

## 验证

- `npm run check` 通过，0 错误。77 条警告均在本次修改范围之外。`npm run build` 通过，保留构建工具的弃用与大分块提示。
- Chromium + 隔离本地 Worker/D1。在 1440px 与 390px 分别走 `/delivery/redemptions` 生成、展示、核对剪贴板与 `/me` 预览及确认兑换。桌面核对 CSV 与原码完全一致。移动端使用无短横小写输入，并核对离开输入框后的 4-4-4 展示。1440px、1024px、390px 均通过已兑换状态与页面无横向溢出检查。另验证作废、审计、停用及已有订阅的 18 种链接入口响应未受影响。截图位于 `/data/tmp/sub-redemption-12-screenshots/`。
- `CI=1 npm test` 通过，67 个测试文件、576 项通过，4 项按默认配置跳过的性能基准。旧码账本兼容测试使用原摘要方式登记 28 位码，分组小写预览和紧凑大写确认成功。错误短码标签即使有对应摘要行也被拒绝。单次短码 10 个账户并发确认得到 1 成功、9 拒绝，最终台账、订阅及确认审计各写入一条，重复确认返回同一张收据。
- 未访问生产 D1，未部署，未推送。交付分支为 `task/sub-redemption-code-12`，bundle 为 `/data/tmp/sub-redemption-code-12.bundle`。

SUB_REDEMPTION_CODE_12_DONE
