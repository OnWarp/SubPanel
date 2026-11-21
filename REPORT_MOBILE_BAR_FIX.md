# 移动端内嵌底栏几何修正报告

分支 `task/mobile-bar-inset-fix`，基线 `793df2d0`，提交身份 `Muse <muse@outtw.com>`

## 变更文件

| 文件 | 变更 |
| --- | --- |
| `src/app/AppShell.tsx` | 管理端与用户端底栏作为应用外壳的直接子元素渲染，与内容面板同级 |
| `src/ui/PageFrame.tsx` | 移除原底栏插槽，保留标题栏和内容滚动区 |
| `src/styles/app.css` | 窄屏 inset 在外壳网格中为底栏分配独立行，使用窗口画布底色，面板和底栏同宽对齐并共用直边接缝 |
| `development/test-mobile-bar-inset.mjs` | 覆盖两种底栏的几何、偏好、键盘操作与安全区，只重新生成 inset 截图 |
| `development/screenshots/mobile-bar-inset/` | 更新管理端与用户端 390px 浅色及深色各一张，另更新管理端 320px 浅色滚动底部一张 |

## 几何断言结果

1. 管理端 `.admin-mobile-dock` 与用户端 `.nav-dock` 均与 `.workspace` 同级，父元素均为 `.app-layout`
2. inset 底栏底边等于视口底边，顶边等于面板底边，左右边界与面板对齐。以 0px 和 34px 底部安全区均通过，安全区增加底栏内部底部留白
3. inset 面板上、左、右边距及上两角圆角与 floating 相同，底部外边距和底角圆角均为 0，底栏下两角沿用面板原圆角
4. inset 滚动区底边等于底栏顶边，外壳网格按底栏实际占高分配滚动区。在 320px 宽度滚到底后，最后一条节点与分页区完整可见
5. floating 保留面板四周 8px 边距、底栏左右 19px 间距、距视口底边 9px 加安全区、68px 高度、34px 圆角、阴影和模糊。四张原 floating 截图字节一致
6. 默认 floating，保留 `subpanel:mobile-bar`、管理端头像菜单分段控件和用户端「我的」显示设置。验证键盘切换、Esc 焦点恢复、跨角色读取、刷新持久化及无效值回退。保留导航入口、选中态及跳转，768px 和 1440px 隐藏移动底栏与切换控件

## 验证

- `npm run check` 通过，0 错误
- 生产构建通过，Vite 提示主 JS chunk 大于 500 kB
- 五个既有套件通过，Worker 514、页面 227、controls 33、subscriptions 14、templates 93
- `node development/test-mobile-bar-inset.mjs` 对生产静态构建运行通过，减弱动画断言兼容 `0ms` 与压缩后的 `0s`

## 未做项

真机安全区未实测，使用 Chromium 注入 34px 安全区完成验证。生产部署未执行

构建产物和验证日志位于 `/data/tmp/mobile-bar-inset-fix/`，交付包位于 `/data/tmp/mobile-bar-inset-fix.bundle`，以 `793df2d0` 为前置提交
CODEX_MOBILE_BAR_FIX_DONE
