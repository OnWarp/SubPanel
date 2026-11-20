# SubPanel 附加配置 P4 客户端验收准备线报告（REPORT_TEMPLATE_P4_PREP）

## 1. 概述与交付目标

本报告对应 Roye《SubPanel 附加配置完善开发方案》（基线 `a818d3a7`）中 **P4 客户端验收准备线** 的交付成果。
在 P1（数据与接口一致性）与 P2（下发与校验）由另一条线并行开发期间，本线完成了验收所需的全套基础设施准备：
1. **真实 Mihomo 内核自动化准备脚本**（含版本与 SHA-256 强校验）；
2. **涵盖方案 §4 与 §10 的 11 项验收夹具集与示例假节点名单**；
3. **单命令多模式验收运行脚本**（支持内置朴素替换与集成 `RENDER_CMD`）；
4. **基线代码完整预跑与基准结果记录**。

---

## 2. Mihomo 内核规格与准备脚本

- **官方内核版本**：`v1.19.34`（MetaCubeX/mihomo 官方 Release）
  - 版本输出：`Mihomo Meta v1.19.34 linux amd64 with go1.26.11 Wed Nov 11 06:48:42 UTC 2026`（`with_gvisor`）
- **固定 SHA-256 校验和**：
  `2763f5b414527f7baf6dc57e3f82f3ab561eedf34bfd7c2f2cde1f7e592efe06`（`mihomo-linux-amd64-compatible-v1.19.34.gz`）
- **内核准备脚本**：[`development/verification/mihomo/setup-mihomo.sh`](file:///data/workspace/subpanel-p4-prep/development/verification/mihomo/setup-mihomo.sh)
- **内核部署路径**：`/data/workspace/subpanel-p4-prep/development/verification/mihomo/bin/mihomo`
- **优先级与安全策略**：
  1. 优先使用 `MIHOMO_BIN` 环境变量指定路径；
  2. 其次复用本地工作区已就绪核心或系统现有二进制（`/usr/local/bin`、`/opt`、`/data`、`$HOME`）；
  3. 未找到时从官方 GitHub Release 下载固定包，比对死写在脚本内的 SHA-256；若校验和不符立即终止报错，严禁换源硬下；
  4. 二进制文件本身不入 Git 仓库，保证代码仓库纯净轻量。

---

## 3. 验收夹具集与节点数据

夹具全部存放于 [`development/verification/fixtures/`](file:///data/workspace/subpanel-p4-prep/development/verification/fixtures/)，遵守方案 §4 的规范格式（仅包含 `proxy-groups`、`rules`、`rule-providers`，动态节点统一使用 `"$SUBPANEL_NODES"` 占位符）。

### 3.1 示例假节点名单（严格遵循红线，零真实凭据）
- [`nodes.json`](file:///data/workspace/subpanel-p4-prep/development/verification/fixtures/nodes.json)：标准假节点名单（包含 SS、VMess、Trojan 假节点，使用 RFC 5737 保留 IP `192.0.2.10` / `198.51.100.20` / `203.0.113.30` 与 example.com 域名）。
- [`nodes-dup.json`](file:///data/workspace/subpanel-p4-prep/development/verification/fixtures/nodes-dup.json)：同名假节点名单（两个均命名为 `Dummy-HK-01`），用于重名消解测试。
- [`nodes-eq-group.json`](file:///data/workspace/subpanel-p4-prep/development/verification/fixtures/nodes-eq-group.json)：节点名与策略组同名（名为 `Proxy`），用于组名防环消解测试。
- [`nodes-reserved.json`](file:///data/workspace/subpanel-p4-prep/development/verification/fixtures/nodes-reserved.json)：节点名碰撞保留关键字（`DIRECT` 与 `REJECT`），用于保留字消解测试。

### 3.2 11 个场景清单与预期拦截层级（[`fixtures.json`](file:///data/workspace/subpanel-p4-prep/development/verification/fixtures/fixtures.json)）

| 编号 | 场景名称 (`name`) | 模板文件 (`file`) | 节点文件 (`nodes_file`) | 预期目标层级 (`target_stage`) | 预期行为与判定标准 |
|:---:|---|---|---|:---:|---|
| 1 | `valid-private-direct` | `valid-private-direct.yaml` | `nodes.json` | Mihomo 内核层 | 方案 §4 IPv4 私网直连有效模板，全程放行并通过内核检查 |
| 2 | `dup-node-names` | `dup-node-names.yaml` | `nodes-dup.json` | 渲染层 | 示例节点含重名，预期渲染层分配稳定后缀（如 `(2)`）后内核通过 |
| 3 | `node-name-eq-group` | `node-name-eq-group.yaml` | `nodes-eq-group.json` | 渲染层 | 节点名与策略组同名，预期渲染层改名消解自环后内核通过 |
| 4 | `reserved-name` | `reserved-name.yaml` | `nodes-reserved.json` | 渲染层 | 节点名撞 DIRECT/REJECT 保留字，预期渲染层改名消解后内核通过 |
| 5 | `dup-groups` | `dup-groups.yaml` | `nodes.json` | SubPanel 校验层 | 模板含两个同名策略组，预期校验层拦截并定位重名组 |
| 6 | `group-cycle` | `group-cycle.yaml` | `nodes.json` | SubPanel 校验层 | 策略组互相引用成环，预期校验层拦截循环引用 |
| 7 | `bad-rule-target` | `bad-rule-target.yaml` | `nodes.json` | SubPanel 校验层 | 规则目标指向不存在策略组，预期校验层拦截未知目标 |
| 8 | `bad-cidr` | `bad-cidr.yaml` | `nodes.json` | SubPanel 校验层 | IP-CIDR 是错误网段（`999.999.999.999/99`），预期校验层拦截并定位行号 |
| 9 | `unknown-ruleset` | `unknown-ruleset.yaml` | `nodes.json` | SubPanel 校验层 | 规则引用未声明的 RULE-SET，预期校验层拦截未知规则集 |
| 10 | `missing-match` | `missing-match.yaml` | `nodes.json` | SubPanel 校验层 | 规则末尾缺少 MATCH 兜底规则，预期校验层拦截 |
| 11 | `unsupported-expr` | `unsupported-expr.yaml` | `nodes.json` | SubPanel 校验层 | 含逗号正则（如 `(foo,bar)`），预期校验层给出具体不支持诊断 |

---

## 4. 基线预跑结果概要

基线代码 Commit 为 `a818d3a7`。运行命令：
```bash
./development/verification/run-verification.sh --output development/verification/baseline-results.md
```

### 4.1 预跑实测汇总表

| 场景 | 预期 | 校验层实测 | 渲染层实测 | 内核层实测 | 判定 |
|---|---|---|---|---|---|
| `valid-private-direct` | 全程通过 | 放行 | 朴素替换 (成功) | 通过 | **通过** |
| `dup-node-names` | 渲染层稳定改名后内核可过 | 放行 | 朴素替换 (未消解重名/保留名) | 失败 (proxy Dummy-HK-01 is the duplicate name) | **基线未实现** |
| `node-name-eq-group` | 渲染层改名消解后内核可过 | 放行 | 朴素替换 (未消解重名/保留名) | 失败 (loop is detected in ProxyGroup) | **基线未实现** |
| `reserved-name` | 渲染层改名消解后内核可过 | 放行 | 朴素替换 (未消解重名/保留名) | 失败 (proxy DIRECT is the duplicate name) | **基线未实现** |
| `dup-groups` | 校验层拦截并定位 | 拦截 (proxy-groups: 策略组名称重复) | 跳过 (校验层拦截) | 跳过 | **通过** |
| `group-cycle` | 校验层拦截循环引用 | 拦截 (proxy-groups.GroupA: 循环引用) | 跳过 (校验层拦截) | 跳过 | **通过** |
| `bad-rule-target` | 校验层拦截未知目标 | 拦截 (rules.0: 未知目标 NonExistentGroup) | 跳过 (校验层拦截) | 跳过 | **通过** |
| `bad-cidr` | 校验层拦截并定位行号 | 放行 | 朴素替换 (成功) | 失败 (rules[0] IP-CIDR error: payloadRule error) | **基线未实现** |
| `unknown-ruleset` | 校验层拦截未知规则集 | 拦截 (rules.0: 未知规则集 undeclared-provider) | 跳过 (校验层拦截) | 跳过 | **通过** |
| `missing-match` | 校验层拦截缺少末尾 MATCH 兜底 | 拦截 (rules: 缺少末尾 MATCH 兜底规则) | 跳过 (校验层拦截) | 跳过 | **通过** |
| `unsupported-expr` | 校验层给出具体不支持诊断 | 拦截 (rules.0: 规则格式无效) | 跳过 (校验层拦截) | 跳过 | **基线未实现** |

- **通过项（6 项）**：有效基线场景正常通过内核；现有基线校验层已对同名组、循环组、未知组目标、未声明规则集、缺少 MATCH 具备拦截能力。
- **基线未实现项（5 项）**：
  - `bad-cidr`：基线校验层未做 CIDR 参数合法性检查，错误参数穿透至内核，由内核报错。
  - `unsupported-expr`：基线仅给出通用的 `规则格式无效`，未按方案 §4 提供具体的 `不支持含逗号的正则表达式` 诊断。
  - `dup-node-names` / `node-name-eq-group` / `reserved-name`：基线未打通 P1+P2 的外部渲染管道（此处使用内置朴素替换），重名及保留字未改名，由内核直接报同名或回环错。
- 完整细节详见 [`development/verification/baseline-results.md`](file:///data/workspace/subpanel-p4-prep/development/verification/baseline-results.md)。

---

## 5. 集成时的确切运行命令与操作指引

当 P1 与 P2 开发合并后，集成测试人员只需按以下步骤执行端到端验收：

### 步骤 1：准备或核对 Mihomo 内核
```bash
./development/verification/mihomo/setup-mihomo.sh
```
若需要指定已有的 Mihomo 二进制，可预设环境变量：
```bash
export MIHOMO_BIN="/path/to/your/mihomo"
```

### 步骤 2：使用集成渲染器执行验收
验收运行脚本通过占位符 `{fixture}`（模板绝对路径）、`{nodes}`（节点 JSON 路径）和 `{out}`（渲染 YAML 目标路径）与外部渲染能力对接。

**场景 A：调用本地集成测试 Harness / CLI 进行渲染**
```bash
RENDER_CMD="node ./scripts/render-harness.mjs --template {fixture} --nodes {nodes} --out {out}" \
  ./development/verification/run-verification.sh --output ./development/verification/integration-results.md
```

**场景 B：调用公开订阅 HTTP 接口进行渲染**
```bash
RENDER_CMD="curl -sSL -X POST http://127.0.0.1:8787/api/admin/system/subscription-templates/preview-render -H 'Content-Type: application/json' -d @<(jq -n --slurpfile t <(jq -Rs . {fixture}) --slurpfile n {nodes} '{template: \$t[0], nodes: \$n[0]}') -o {out}" \
  ./development/verification/run-verification.sh
```

### 步骤 3：结果表判读标准
运行后查看生成的 Markdown 结果表：
- **目标状态**：所有 11 个场景在实测列均符合预期，最终「判定」列必须**全部显示为「通过」**。
- 若仍出现「基线未实现」或「失败」，根据表格定位具体哪一层（校验层/渲染层/内核层）出现偏差，依方案 §4 与 §10 进行针对性排查。

---

## 6. 未做与存疑项说明

1. **不修改任何既有代码**：严格遵循红线限制，未改动 `worker/`、`src/`、`package.json` 及现有测试文件。
2. **离线假节点安全性**：所有夹具数据均采用本地离线假节点，不依赖任何外部订阅、远程 Provider 下载或 GEOSITE 资源网络更新，保障测试环境幂等隔离。
3. **P1+P2 渲染接入待定参数**：P2 实现的公开接口路径与 CLI 入口将在分支集成时确定，本运行脚本已将 `RENDER_CMD` 解耦为通用字符串占位符，支持任意命令形式接入。
4. **代码递交通道（Git Bundle）**：
   - 本机（loop3）无直接推送至 GitHub 远端的凭据通道。
   - 已使用完整基线 Commit（`a818d3a74b3bf6fcd43ddf02583db70b4b749814`）生成独立 Git Bundle：
     `/tmp/template-p4-prep.bundle`
   - 尝试 SCP 至 hwsg（`124.243.179.34`）鉴权未通过，已按简报要求将完整 bundle 安全保存在 `/tmp/template-p4-prep.bundle` 供下游集成解包与同步。
