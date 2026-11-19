# 简报：附加配置完善 P1＋P2（worker 侧）

## 事实来源
唯一规格是 worktree 根目录的 `ADDITIONAL_CONFIG_PERFECT_PLAN.md`（Roye《SubPanel 附加配置完善开发方案》，基线 a818d3a7），先完整读它。本简报只划阶段边界与红线，与规格冲突时以规格为准。

## 基线与 worktree
- 基线 origin/main `a818d3a7`；worktree `/data/workspace/subpanel-template-perfect`；分支 `task/template-perfect-p1p2`。
- 开工第一件事：在 worktree 跑基线并记进报告——`npm run check`、`npm test`（vitest，预期 481）、页面测试（预期 189）、`npm run build`。规格 §1 的现状结论来自源码核对、未跑测试，以实跑为准；数字有出入先在报告中标明再继续，不要迁就预期改测试。
- **禁止 `git add -A`**：worktree 的 node_modules 是符号链接（曾有把符号链接提交进仓库的事故）。逐个 add 实际改动的文件，提交前 `git status` 复核。

## 本线范围：只做 P1＋P2，分两个阶段各成一组提交

### P1 数据与接口一致性（规格 §5、§6）
- 先读实际 migrations 与四张模板表（subscription_templates / subscription_template_versions / subscription_template_default / subscription_template_bindings）的现有定义，定下一条迁移编号追加迁移，**不重建已有表**。按 §5 表补字段：模板 revision/draft_hash/来源元信息（source_fetched_at/source_etag/source_last_modified 等）、版本 sequence/normalized_json/content_hash/validator_version/created_by、默认与绑定的 revision/updated_at，并回填历史数据。
- 草稿更新、发布、回退、归档、设默认、绑定一律带 expectedRevision 乐观锁，冲突返回 409 `TEMPLATE_CONFLICT`。
- 发布走 D1 batch 原子事务：事务内重校验草稿修订、创建不可变版本、条件切换指针，失败不留生效版本或孤立写入。回退只切指针并记审计事件，草稿保留。
- 归档先查引用：全局默认、直接绑定、继承影响分开计；有引用返回 409 `TEMPLATE_REFERENCED` 并带引用摘要。
- 读侧一次 JOIN 定版（绑定＋默认＋模板＋版本同一快照），不在多条语句间拼状态。
- 列表接口分页（q/page/pageSize/archived），响应 DTO 统一 camelCase，列表不带草稿全文。按 §6 表实现 `/validate`、`/preview`、`/:id/import`（只返回候选内容与来源元信息，管理员保存才写草稿）、versions/rollback/archive/default/bindings 各端点；新错误码按 §6（TEMPLATE_CONFLICT / TEMPLATE_INVALID / TEMPLATE_REFERENCED / TEMPLATE_UNPUBLISHED / TEMPLATE_OUTPUT_INVALID / TEMPLATE_STORAGE_NOT_READY），沿用现有错误信封，不回堆栈与节点凭据。
- 订阅创建/更新同事务保存绑定：先核实 delivery 实际存储模式——D1 模式同事务写入；若仍有 KV 路径，按规格做管理端明确提示且**不许先报成功后丢绑定**。删除订阅时清理绑定。复制配置只生成独立草稿，不复制发布版本与订阅引用。

### P2 下发与校验（规格 §4、§7、§8）
- validation 拆分：结构校验 / 规则校验 / 规范化 / 诊断 / 占位符展开分开成段。诊断结构统一 `{code, severity, path, line?, column?, message}`。
- 规则校验按 §4 表：规则类型与字段数、末尾唯一 MATCH、规则目标存在、RULE-SET 与 provider 兼容（no-resolve、mrs/behavior 组合）；rule-providers 由服务端生成稳定相对 path，防冲突与目录穿越。
- 命名用稳定 ID 排序解决同名竞争，保证确定性输出（相同模板＋相同授权节点输入 → 相同字节）。
- compiler 统一批量编译与公开实时两条路径的模板应用；产物补 rendererVersion / templateVersionId 可选字段，旧产物读侧识别后重建。
- **公开路径缓存缺失或版本不匹配时实时重建＋waitUntil 回填，合法订阅不许因缓存问题 404**；授权永远实时判定，过期权益不许从旧缓存拿到节点；重建失败返回服务错误并记原因，不映射成订阅不存在。
- ETag 按最终输出字节计算，304 仅在内容一致且授权仍有效时返回。零节点走现有不可用路径并给原因（预览 DTO 带 zeroNodeReason）。预览 DTO 按 §6：effectiveVersionId、outputNodes、zeroNodeReason、groups、rules、ruleProviders、ignored。
- 远程导入复用 `worker/catalog/remote.ts` 的 fetchRemoteText 并补齐：仅 HTTPS、10 秒总超时、≤3 次重定向（每次重定向重新校验）、响应字节上限、ETag/Last-Modified 条件导入（304 提示来源未更新）。导入只回候选、不自动发布，失败不覆盖既有草稿与发布版本。

## 出站红线（长期纪律，不许突破）
- 远程模板**只许管理员点击时单次抓取**，不许做任何定时、自动、后台的远程模板更新或轮询探活。
- rule-providers 由客户端（Mihomo）自行拉取，**服务端永不抓取**。
- 任何新增出站调用都要有失败上限与明确错误返回，不做无退避重试循环。

## 不在范围
- P3 管理 UI（TemplatesSection 拆分、TemplateBinding 受控字段等）：排版线落地后另开线，本线不改前端页面结构（如 P1 的 DTO 变化需要同步 `src/app/api.ts` 类型，仅限类型对齐，不做 UI 改版）。
- P4 客户端验收不在本线。
- 自动测速组、地区筛选、Subconverter、MiSub 占位符适配、其他客户端模板一律不做。

## 测试要求
- 新增测试集中覆盖规格 §10 的关键回归：并发编辑/发布 409、归档竞争（与默认切换/绑定竞争）、发布原子性（失败无部分提交）、缓存缺失/旧产物重建、过期权益拿不到节点、零节点原因、远程导入失败不覆盖草稿。
- 能用真实 Mihomo 内核验证就验 §4 的私网直连示例模板（盒上此前跑过 mihomo 真核心），把内核版本与结果记进报告；跑不了的单列在报告「未验证」段，不许假装验过。
- 完工时 check / vitest / 页面测试 / build 全绿，数字与基线对照写进报告。

## 交付
- 两个阶段各成一组提交（P1 一组、P2 一组），提交信息写清阶段。
- 完工必须 `git push` 远端分支 `task/template-perfect-p1p2`（用 worktree 既有推送方式；推送失败在报告写明原因）。
- 报告写到分支内 `REPORT_TEMPLATE_PERFECT_P1P2.md`：基线数字、迁移编号与字段清单、逐项完成对照（P1/P2）、新测试清单与结果、Mihomo 实测结果或未验证清单、与规格的偏差（如有）及理由。
- 全部完成后在日志打印一行 `PI_TEMPLATE_PERFECT_DONE`。
