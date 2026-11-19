# 移动端悬浮胶囊验收报告

基线为 `a14038392d9f46ea23235d4674be1bec3714b522`，交付分支为 `task/mobile-nav-verify`。规格文件 `development/tests/browser/mobile-nav.spec.ts` 共 10,122 字节，使用 390×844 视口，Playwright 发现 12 个 Chromium 用例。

## 基线实跑

在 loop4 执行 `npm run test:e2e -- mobile-nav.spec.ts`，退出码为 1。Cloudflare Vite 插件调用 `os.networkInterfaces()` 时收到 `ERR_SYSTEM_ERROR: uv_interface_addresses returned Unknown system error 1`，Vite 退出，仓库的 E2E 启动脚本未启动 Playwright 浏览器测试。独立 Node 探针尝试监听 `127.0.0.1` 时也收到 `listen EPERM`。实际执行断言 0 条，以下静态预期均待浏览器复核。

| 简报项 | 断言 | 基线实跑 | 原因分类与静态预期 |
| --- | --- | --- | --- |
| 1 | 管理端入口恰好 4 个，标签顺序正确 | 未执行 | 环境阻断。基线渲染 6 个入口，前四项顺序相符，完整列表应失败。 |
| 1 | 依次从概览、节点管理、订阅管理、用户管理点击到 `/dashboard`、`/catalog/nodes`、`/delivery/subscriptions`、`/users`，并更新当前项 | 未执行 | 环境阻断。移动底栏与桌面侧栏共享 `adminDomains`，四个落点和当前项静态相符，预期通过。 |
| 2 | 管理端底栏固定，三侧间隙均大于零，链接同一行 | 未执行 | 环境阻断。基线固定定位、三侧至少 8px 且禁止换行，预期通过。 |
| 2 | 管理端底栏四角均为胶囊全圆角 | 未执行 | 环境阻断。基线底栏使用 16px 卡片圆角，预期失败。 |
| 3 | 管理端当前入口唯一，背景不透明且区别于未选中项，靛蓝背景、白色前景、胶囊圆角 | 未执行 | 环境阻断。基线当前项及背景区分预期通过。背景为浅混色、前景为主题主色，入口圆角为 6px，精确颜色和胶囊圆角预期失败。 |
| 4 | 顶栏头像菜单恰好五项 | 未执行 | 环境阻断。基线已有账户安全、外观、退出登录，缺少运营管理与系统设置，计数及缺失项预期失败。 |
| 4 | 头像菜单点击运营管理直达 `/delivery/tickets`，点击系统设置直达 `/system/registration` | 未执行 | 环境阻断。两条基线菜单入口都缺失，预期在入口可见性断言失败。 |
| 5 | 用户端四个标签及顺序，三侧间隙、固定定位、同一行与底栏全圆角 | 未执行 | 环境阻断。基线四项、14px 间隙及固定单行布局预期通过。60px 高的底栏仅设 12px 圆角，胶囊形态预期失败。 |
| 5 | 用户切到订阅后仅订阅为当前项，背景不透明且区别于未选中项，入口为胶囊圆角 | 未执行 | 环境阻断。基线已有当前项标记和实色选中背景，入口仍为 6px 控件圆角，胶囊形态预期失败。 |
| 6 | 20 行节点列表滚到末尾时，页脚整块在视口内且底边不低于悬浮条顶边 | 未执行 | 环境阻断。基线工作区已有 96px 底部留白，预期可能通过，需实测滚动容器、页脚与底栏的边界。 |

## 静态自查

- Playwright 用仓库配置成功解析规格并列出全部 12 个用例。严格 TypeScript 检查通过，核对了导入、定位器 API 和角色选项。
- 管理员初始化和表单登录沿用 `admin-frontend.spec.ts` 的用户名、密码和标签。普通用户沿用 `user-subscriptions.spec.ts` 的邀请 API 和表单登录，单独开浏览器上下文。节点页用现有规格的 catalog 响应形状造数据，导航和布局取自实际页面。
- 借用 loop4 的 `subpanel-domain-simplify/node_modules`，未安装依赖。原 worktree 的 Git 元数据只读，指定路径暂存时无法创建 `index.lock`。使用 `/tmp` 可写克隆，从相同分支和基线复制规格和本报告，只暂存并提交这两个新增文件，再生成 bundle。

## 在 loop2 复跑

将 bundle 复制到 loop2 的 `/tmp/mobile-nav-verify.bundle`。以下命令从 loop2 的 SubPanel 集成 worktree 根目录运行，使用该 worktree 的依赖和 Playwright Chromium。仓库 E2E 命令会重置当前 worktree 的本地 `.wrangler/state`。

在独立基线 worktree 中复跑并记录实际红灯。

```bash
git fetch /tmp/mobile-nav-verify.bundle refs/heads/task/mobile-nav-verify
verify_commit=$(git rev-parse FETCH_HEAD)
git worktree add --detach /tmp/subpanel-mobile-nav-baseline "$verify_commit"
ln -s "$(realpath node_modules)" /tmp/subpanel-mobile-nav-baseline/node_modules
(cd /tmp/subpanel-mobile-nav-baseline && npm run test:e2e -- mobile-nav.spec.ts)
```

随后在已合入胶囊改造的集成 worktree 根目录运行。若验证提交已合入，直接执行最后一条命令。

```bash
git fetch /tmp/mobile-nav-verify.bundle refs/heads/task/mobile-nav-verify
git cherry-pick FETCH_HEAD
npm run test:e2e -- mobile-nav.spec.ts
```

尚待验证的是全部用例的浏览器行为，包括真实登录与邀请、基线实际通过或失败明细，以及集成版本上的点击落点、计算样式和滚动遮挡。
