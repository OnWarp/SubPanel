# P2 修改密码文案回归修复报告

## 复现

在 `instabox-loop5` 上确认 `/data` 可用空间为 5.5 GB，Git 身份为 `Muse <muse@outtw.com>`。修复分支基于 `task/sub-modal-p2` 的 `3cbbedc`。

修复前单跑 `user-pages-style.test.tsx`，5 项通过，1 项失败。失败项为 `keeps account security copy and does not add self-service deletion`。P2 源码已缺失「用户名不可修改，」，且关闭的弹窗不会挂载密码表单正文。

## 修复

- 在现有共享 Dialog 内恢复整句「用户名不可修改，新密码须为 12 至 128 个字符」，沿用现有布局和表单控件。
- 原 Node 用例保留会话和自助注销、删除账户相关断言。对完整文案的断言改为渲染初始打开状态并检查 Dialog 内的正文。`AccountPage` 的可选 `initialPasswordOpen` 用于该静态渲染场景，默认值为 `false`。
- 现有 Chromium P2 用例从安全页点击「修改密码」，在打开的 Dialog 内断言整句可见。

## 验证

- pages-node 通过 232/232 项。
- `npm run check` 通过，0 错误，75 条警告均位于本次未改动的文件。
- `npm run build` 通过，Vite 报告产物分块大小警告。
- `CI=1 npm test` 通过，67 个测试文件、576 项通过、4 项按原有环境开关跳过的性能基准。
- Chromium 回归通过 65/65 项，覆盖 `modal-p0`、`modal-p1`、`modal-p2` 和 `template-p3`。修改密码用例在 390、1024 和 1440 px 均验证了整句可见。
- 简报记录的 `auth.spec.ts` 主题持久化问题属于基底。本次浏览器回归运行的是上述四个套件。
- 三张修改密码弹窗截图见 `development/screenshots/sub-modal-p2-fix/`，截图在填写表单之前采集。

SUB_MODAL_P2_FIX_DONE
