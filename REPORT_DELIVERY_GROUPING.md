# 订阅分发 · 分享设置分组交付报告

基线为 `5946692180d8f47198e3db4b1b4cf591cf0ed17a`。出包前通过 GitHub 查询 `onwarp/SubPanel` 的 `main`，仍指向该提交。

## 字段归组

| 现行字段 | 配置键 | 归入 |
| --- | --- | --- |
| 分享功能 | `enabled` | 分享开关 |
| 创建分享 | `createAllowed` | 分享开关 |
| 默认允许原始链接 | `defaultAllowOriginalLink` | 默认策略 |
| 默认要求登录 | `requireLoginDefault` | 默认策略 |
| 默认访问保护 | `defaultAccessControl` | 默认策略 |
| 公网基址 | `publicBaseUrl` | 默认策略 |
| 单订阅分享上限 | `maxSharesPerSubscription` | 分享限额 |
| 单用户有效分享上限 | `maxActiveSharesPerUser` | 分享限额 |
| 最长有效期（天） | `maxValidityDays` | 分享限额 |

已逐项核对原卡的九个字段。公网基址原本位于该卡，连同原帮助文案归入默认策略。保存胶囊位于第一张卡的卡头，原表单统一校验并通过 `PUT /api/admin/share-settings` 提交全部九个字段。加载、重试、控件属性、字段文案、校验、默认值和权限语义沿用基线。

## 改动文件

- `src/features/system/ShareSettingsSection.tsx` 将三个语义组渲染为同级卡片，并共用原保存表单
- `src/features/system/SystemPage.tsx` 订阅分发主视图使用无卡片外框的容器，使新增卡片独立展示
- `src/styles/pages-admin-ops.css` 为分发页设置卡间距、卡头发丝线及内边距，三个数值字段同列等宽，沿用现有配色令牌
- `REPORT_DELIVERY_GROUPING.md` 记录交付和验收结果

## 验收实跑

| 命令 | 59466921 基线 | 改动版 |
| --- | --- | --- |
| `npm run check` | 通过，0 错误 | 通过，0 错误 |
| `npm test` | 启动失败，无测试计数 | 启动失败，无测试计数 |
| `vitest run --config development/vitest-pages-node.config.ts` | 14 文件，189/189 通过 | 14 文件，189/189 通过 |
| `npm run build` | 通过 | 通过 |
| `npm run test:e2e` | 启动失败，无测试计数 | 启动失败，无测试计数 |

全量 Vitest 的 Worker 池监听 `127.0.0.1` 时返回 `EPERM`。浏览器套件的 Vite 启动在 `uv_interface_addresses` 返回系统错误，退出码为 1。构建日志包含超过 500 kB 的 chunk 提示。运行日志位于 `/data/tmp/delivery-grouping/`，文件名分别以 `baseline-` 和 `final-` 开头。

### 390 px 与 1440 px 截图自查

两个尺寸均未生成截图。直接启动无头 Chromium 也被沙箱拦截，Crashpad 调用 `setsockopt` 返回 `Operation not permitted`，进程以 `SIGTRAP` 退出。

替代静态自查通过。逐项比对了九个字段的 JSX、控件属性、错误绑定和处理函数，核对了三张同级卡的字段顺序与唯一表单提交入口。390 px 命中现有 720 px 单列断点，卡头与表单分别有水平内边距。1440 px 的成对开关使用两列，三个限额字段均在一列且同宽。宽度规则允许控件随容器收缩。贴边与裁切仍缺浏览器实测。

## 提交与 bundle

原工作树的 Git 元数据及 `/data` 根目录在沙箱内只读。提交保存在 `/data/tmp/delivery-grouping/checkout` 的 `task/delivery-settings-grouping` 分支，沿用现有依赖文件的符号链接，并单独暂存具体文件。bundle 保存路径为 `/data/tmp/delivery-grouping/delivery-settings-grouping.bundle`，以 `59466921` 为前置提交。无远端推送。

`git bundle verify` 预检输出摘录（分支提交 ID 以最终 bundle 为准）：

```text
The bundle contains this ref:
The bundle requires this ref:
5946692180d8f47198e3db4b1b4cf591cf0ed17a
The bundle uses this hash algorithm: sha1
/data/tmp/delivery-grouping/delivery-settings-grouping.bundle is okay
```

CODEX_DELIVERY_GROUP_DONE
