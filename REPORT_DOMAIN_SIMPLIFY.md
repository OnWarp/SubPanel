# 系统设置域名简化报告

分支 `task/domain-simplify`，基线 `bf9cc2d1`，简报记录的全量基线为 481 条

## 简报对照

1. 面板域名和订阅域名共用紧凑行布局。主行显示域名、验证状态圆点和主域名标记，灰色副行显示备注和最近验证时间，并保留验证失败详情。点击备注或「添加备注」就地编辑，回车走既有 `PATCH { note }` 保存，Esc 取消，保存失败时保留草稿
2. 以绿、黄、红圆点区分已验证、待验证和验证失败，圆点带可访问状态名称。启用状态由行尾原有开关表达。「•••」菜单收纳验证、设为主域名和删除，主域名行省略「设为主域名」，其删除项仍禁用。可删除域名继续使用原确认弹窗
3. 每张卡片的添加表单默认收起。点击卡片头「＋ 添加域名」展开域名和备注字段，沿用既有提交接口，成功后收起，失败时保留填写内容
4. 两段各用一张卡片，复用运营页圆角外壳、胶囊主操作、溢出菜单和总数卡片脚。列表采用横向细线与两行信息结构，沿用现有列表的展示方式，未加入分页。浅色画布使用现有 `#F5F5F7`，深色画布使用 `#08090A`。主按钮复用现有主题令牌，基线浅色主色为 `#0071E3`，深色主色为 `#5E6AD2`
5. 样式改动限定在 `pages-system.css` 的域名专用类。窄屏下长域名和备注可换行，行尾保留开关和菜单的空间，添加字段可各占一行。分享设置、域名限制、订阅平台展示和其他设置沿用原实现

接口路径、HTTP 方法、请求字段、路由和数据结构均沿用基线实现。备注保存复用原有操作反馈与刷新流程，通过操作结果决定何时退出编辑

## 改动文件

- `src/features/system/DomainSettingsSection.tsx` 域名卡片、行内备注、行尾菜单和添加表单呈现
- `src/styles/pages-system.css` 域名行、状态圆点、备注和窄屏布局
- `development/tests/browser/system-domains.spec.ts` 390px 浏览器回归，覆盖两张卡片、主域名菜单、备注保存和取消、删除确认与取消、添加表单
- `REPORT_DOMAIN_SIMPLIFY.md` 本报告

## 测试结论

| 检查 | 基线 | 结果 |
| --- | --- | --- |
| `npm run check`（Wrangler、TypeScript、Oxlint） | — | 通过，Wrangler 日志目录指向可写的 `/tmp` |
| `npm run build` | — | 通过，Vite 报出大于 500 KB 的 chunk 提示 |
| `npm test` | 481 条 | Vitest Worker 池启动时监听 `127.0.0.1` 被拒绝（`EPERM`），未运行测试 |
| `vitest-pages-node.config.ts` | 187/187 | 187/187 |
| `vitest-subscriptions-node.config.ts` | 14/14 | 14/14 |
| `vitest.controls.config.ts` | 32/32 | 32/32 |
| `vitest.templates.config.ts` | 80/80 | 80/80 |
| Playwright 域名用例 | — | `--list` 成功发现用例，执行受沙箱限制 |

四组无 socket 配置存在重复用例，分别与同一基线的结果比对

## 未验证项

- 集成时需在可监听 localhost 的环境复跑全量 481 条 Worker 测试，包括使用 Cloudflare Worker 和 D1 的 `d1-domains.test.ts`
- 仓库的浏览器测试脚本启动 Vite 时，网络接口枚举被沙箱拒绝（`uv_interface_addresses` 返回错误 1）。单独尝试启动 Chromium 也被沙箱拒绝（`setsockopt: Operation not permitted`）。390px 的实际渲染、亮暗主题和浏览器交互留待集成环境复验
