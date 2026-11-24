# SubPanel Modal P0 交付报告

## 范围与扫描

- 工作树 `task/sub-modal-p0`，基底 `origin/main` 的 `bfdb8a625`。核对提交身份 Muse / muse@outtw.com，开工时 `/data` 有 约 6,450 MB 可用空间。
- 从 `src` 的 Drawer、Dialog、Modal、Sheet 和 Portal 命名、定义及 JSX 调用正向追踪打开和关闭状态，再用 `showModal`、`createPortal`、`window.confirm`、`popover`、`aria-modal`、遮罩及固定定位 CSS 反查。按路由复核公开分享、邀请、登录、注册、初始化及个人兑换入口。
- [仓库清单](docs/modal-inventory.md) 登记 52 个业务调用点，含 17 个 EditDrawer、27 个 ConfirmDialog、7 个直接 Dialog 和 1 个 ShareDrawer 包装入口。另登记 1 个原生确认、4 个锚点 Popover、2 个标题栏 Portal，以及仅有样式的兼容规则。未发现运行中的自定义全屏遮罩或 Sheet。
- [方案 §5](SubPanel_Modal_Interaction_Refactor.md#5-兑换码生成结果专项) 已将示例纠正为 12 位 3 组 `XXXX-XXXX-XXXX`。当前基底已包含兑换码页面，格式收敛提交 `0755adb` 当时仍在独立分支。结果抽屉继续展示 API 返回的完整码，待该分支集成后由其提供 12 位结果。

## 实现与文件

| 文件 | P0 变更 |
|---|---|
| `src/ui/Dialog.tsx` | 沿用原生 dialog 顶层与背景隔离。集中处理 X、ESC、遮罩与 footer 取消。忙时拦截关闭，脏内容和敏感结果禁用遮罩关闭。放弃确认在窗内完成。开启时聚焦字段或指定安全动作，限制 Tab 走出窗口，关闭与卸载后恢复触发控件，触发项不可用时回退至菜单或内容区域。补齐可访问标题、可选描述和 aria-modal |
| `src/ui/ConfirmDialog.tsx` | 改由 Dialog 提供共享布局与行为。沿用原有确认与取消接口、遮罩不关闭策略，危险确认优先聚焦取消 |
| `src/styles/tokens.css`、`src/styles/components.css` | S/M/L/XL 最大宽度为 400/520/720/960px，共用浅深色表面与焦点样式。锁定页面和工作区滚动，正文独立滚动。桌面按 88dvh 限高，移动按可用视口 90% 限高并处理安全区。40% 遮罩，160ms 入场动画，尊重 reduced-motion |
| `src/styles/pages-user-d.css` | 居中 Dialog 使用共享圆角。保留旧抽屉及兼容选择器的规则 |
| `src/features/accounts/UsersPage.tsx` | 编辑邮箱和密码重置的底部关闭动作接入守卫。生成临时密码后屏蔽遮罩关闭，继续沿用原有完成和清理流程 |
| `src/features/tickets/TicketsPage.tsx` | 新建工单将提交中状态与取消动作交给共享守卫 |
| `src/features/system/TemplateEditor.tsx` | 发布确认使用 XL，离开草稿确认使用 S。取消、忙中关闭和草稿关闭策略交给共享守卫 |
| `src/features/system/TemplateList.tsx` | 默认配置与归档使用 S，复制使用 M，版本历史使用 XL。取消回退继续留在版本历史 |
| `docs/modal-inventory.md`、`SubPanel_Modal_Interaction_Refactor.md` | 调用审计及兑换码示例修正 |
| `development/tests/browser/modal-p0.spec.ts`、`development/screenshots/sub-modal-p0/` | P0 双宽度回归和八张截图 |

既有抽屉继续沿用 EditDrawer 及其关闭、尺寸、焦点和正文滚动规则。后端、数据库迁移、旧订阅链接及令牌接口沿用基底。

## 验证

| 项目 | 结果 |
|---|---|
| `npm run check` | 通过，0 错误，78 条 lint 警告 |
| `npm run build` | 通过，Vite 报告客户端主包超过 500 KB 的分块提示 |
| `CI=1 npm test` | 67 个文件通过，574 项通过，4 项沿用已有跳过 |
| Chromium 回归 | 9 项 P0 场景和 1 项既有域名回归通过，覆盖 1440px / 390px。各宽度验证工单 Dialog 的焦点进入、双向 Tab 循环、焦点样式、背景锁滚、正文滚动、ESC 和关闭后焦点恢复，来源抽屉的靠右布局、遮罩、ESC、关闭按钮和正文滚动，兑换码停用确认的安全默认焦点，以及 XL 历史窗关闭、取消回退与卸载后焦点恢复。桌面另验证邮箱未保存保护和临时密码结果的遮罩拦截及关闭后清理 |
| 截图 | [1440px / 390px 截图](development/screenshots/sub-modal-p0/) 各四张，合计约 380 KB |

使用本机 Chromium 运行 Playwright。旧 `template-p3.spec.ts` 有先于 P0 的失效断言，其中列表测试仍访问 `/system/distribution`，已在 `bfdb8a625` 的独立副本复现。P0 版本历史测试访问当前的 `/delivery/conversions`。390px 的旧用户页 CSS 隐藏用户操作行，邮箱和密码守卫使用桌面入口回归。移动尺寸使用浏览器模拟，真实设备软键盘及 Safari 尚无实机结果。

## 回滚

在集成分支上对 P0 提交执行 `git revert`，再重新运行检查、构建与测试。P0 没有数据变更，回滚无需迁移或恢复数据。

SUB_MODAL_P0_DONE
