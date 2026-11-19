# SubPanel P4 模板验收基线预跑结果表

- **预跑时间**: 2026-11-19 19:08:13Z
- **基线 Commit**: `a818d3a7`
- **Mihomo 内核版本**: Mihomo Meta v1.19.34 linux amd64 with go1.26.11 Wed Nov 11 06:48:42 UTC 2026
- **Mihomo 内核路径**: `/data/workspace/subpanel-p4-prep/development/verification/mihomo/bin/mihomo`
- **渲染执行模式**: 朴素替换
- **夹具定义清单**: `/data/workspace/subpanel-p4-prep/development/verification/fixtures/fixtures.json`

## 验收场景矩阵与基线实测

| 场景 | 预期 | 校验层实测 | 渲染层实测 | 内核层实测 | 判定 |
|---|---|---|---|---|---|
| `valid-private-direct` | 全程通过 | 放行 | 朴素替换 (成功) | 通过 | **通过** |
| `dup-node-names` | 渲染层稳定改名后内核可过 | 放行 | 朴素替换 (未消解重名/保留名) | 失败 (proxy Dummy-HK-01 is the duplicate name) | **基线未实现** |
| `node-name-eq-group` | 渲染层改名消解后内核可过 | 放行 | 朴素替换 (未消解重名/保留名) | 失败 (loop is detected in ProxyGroup, please check following ProxyGroups: [Proxy]) | **基线未实现** |
| `reserved-name` | 渲染层改名消解后内核可过 | 放行 | 朴素替换 (未消解重名/保留名) | 失败 (proxy DIRECT is the duplicate name) | **基线未实现** |
| `dup-groups` | 校验层拦截并定位 | 拦截 (proxy-groups: 策略组名称重复) | 跳过 (校验层拦截) | 跳过 | **通过** |
| `group-cycle` | 校验层拦截循环引用 | 拦截 (proxy-groups.GroupA: 循环引用) | 跳过 (校验层拦截) | 跳过 | **通过** |
| `bad-rule-target` | 校验层拦截未知目标 | 拦截 (rules.0: 未知目标 NonExistentGroup) | 跳过 (校验层拦截) | 跳过 | **通过** |
| `bad-cidr` | 校验层拦截并定位行号 | 放行 | 朴素替换 (成功) | 失败 (rules[0] [IP-CIDR,999.999.999.999/99,DIRECT,no-resolve] error: payloadRule error) | **基线未实现** |
| `unknown-ruleset` | 校验层拦截未知规则集 | 拦截 (rules.0: 未知规则集 undeclared-provider) | 跳过 (校验层拦截) | 跳过 | **通过** |
| `missing-match` | 校验层拦截缺少末尾 MATCH 兜底 | 拦截 (rules: 缺少末尾 MATCH 兜底规则) | 跳过 (校验层拦截) | 跳过 | **通过** |
| `unsupported-expr` | 校验层给出具体不支持诊断 | 拦截 (rules.0: 规则格式无效) | 跳过 (校验层拦截) | 跳过 | **基线未实现** |

## 结果分析与判定说明

1. **有效基线 (`valid-private-direct`)**：全程放行与解析成功，Mihomo 内核检查成功通过（**通过**）。
2. **既有校验拦截场景 (`dup-groups`, `group-cycle`, `bad-rule-target`, `unknown-ruleset`, `missing-match`)**：SubPanel 基线现有 `worker/templates/validation.ts` 已具备对同名组、循环引用、未知目标、未声明 RULE-SET、缺失末尾 MATCH 的校验能力，直接在校验层精准拦截，渲染与内核层安全跳过（**通过**）。
3. **网段格式校验 (`bad-cidr`)**：基线校验层仅校验字段数与类型列表，未校验 IP-CIDR 参数合法性，错误网段穿透至内核并在内核层报错（`payloadRule error`）。如实标记为 **基线未实现**，待 P2 补齐网段校验后转为通过。
4. **复杂表达式诊断 (`unsupported-expr`)**：基线目前按逗号分割规则产生长度不符，抛出通用 `规则格式无效` 错误，尚未提供方案 §4 规定的针对含逗号正则的具体不支持诊断。如实标记为 **基线未实现**，待 P2 细化诊断后转为通过。
5. **节点名消解与冲突场景 (`dup-node-names`, `node-name-eq-group`, `reserved-name`)**：模板校验层合法放行；但在基线未挂载 P1+P2 渲染 harness 前，朴素替换未实现同名序号递增与保留字规避，导致内核层出现同名或环引用报错（`duplicate name`、`loop is detected in ProxyGroup`）。如实标记为 **基线未实现**，待 P1+P2 订阅渲染管线就绪后通过 `RENDER_CMD` 即可全部转为通过。
