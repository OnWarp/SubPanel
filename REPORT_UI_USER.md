# REPORT — UI 升级·线 B：用户侧五页

基线 fd6397e，分支 task/ui-user-sub。范围：首页、订阅页、节点页、APP 页（用户侧）、我的（含个人中心 AccountPage、EmailBindChangeForm、ProfileCard）。未碰管理页与 worker 逻辑，未改接口与数据流。

验证：npm run check 0 警告 0 错误；npm test 50 套件 / 374 条全过（含 smoke）；npm run build 全绿。

## 1. 逐页删除的文字（方案 §4）

- 五页 PageHeader 的 description 全部删除：首页「查看当前订阅和即将到期的提醒」、订阅页「N 个订阅 · 选择一个订阅查看客户端链接」、节点页「汇总名下订阅里的可用节点」、APP 页「按平台查看可下载的 APP」、我的「资料、会话与账户安全」、个人中心「资料、头像与账户安全」
- 首页：整段「快捷操作」与「最近到期」区块删除（§8 首页只留状态卡 + 主订阅链接区）；状态卡内「此订阅已停用，链接暂时不会提供内容」说明句删（徽章已表达）；空状态说明「管理员分配订阅后，状态会显示在这里」删，标题改「暂无订阅」
- 订阅页：空状态说明「管理员创建订阅后，它会出现在这里」删；状态卡同款停用说明句删；客户端链接行内的「自动识别 / 专用格式」副标签随列表改分段控制一并去掉
- 节点页：空状态说明「订阅分配分组后，节点会显示在这里」删；顶部汇总条（节点总数 / 来自分组数）整条删除（§8 纯列表）
- APP 页：两个空状态的说明句删（「管理员已关闭 APP 下载板块，开启后可在这里查看各平台的下载入口」「该平台下暂时没有可下载的 APP」）；平台筛选行上的「平台」标签字删（分段控制自明）
- 我的 / 账户：ProfileCard 的「绑定邮箱后，管理员头像将显示 Gravatar」提示句删；邮箱表单两条小贴士删（「绑定后可使用邮箱登录」「当前邮箱：…，验证码将发送至新邮箱」，当前邮箱在资料卡已展示）
- 保留并说明：订阅页「兼容诊断」折叠区内的一句 DIAGNOSTIC_HELP 已在 details 披露区内，符合 §4.3 收进披露区；订阅域名未配置的 linkError 警告属错误类文字，保留

## 2. 按钮归位与结构变更（方案 §5/§8）

- 首页：新增主订阅链接区——SegmentedControl 切平台只换链接、不跳页，等宽链接 + CopyButton 成组；原自维护 copied 状态 + StatusMessage 的复制反馈整套删除；剩余天数改大字展示（--font-display / 600）
- 订阅页：原「订阅链接」主链接卡与「客户端链接」逐行列表合并为一个链接区——分段控制在上，链接 + CopyButton + 二维码三件套成组；逐行复制/二维码图标钮与二维码弹窗随之删除，二维码随选中平台即时生成；新令牌条的复制迁 CopyButton（iconOnly）；令牌重置改 Button danger；错误重试改 Button secondary；分享按钮因 ShareDrawer 需要 ref 保留原生 button（类名与共享 Button 输出一致）
- 节点页：分组筛选由 FilterChip 改 SegmentedControl；订阅筛选保留 FilterChip（见遗留登记）；搜索与表格不动
- APP 页：平台 FilterChip 改 SegmentedControl；卡片简介改一行截断；「使用说明」由次按钮改强调色文字链接，置于下载主按钮旁
- 我的：改 iOS 式分组列表两组（入口组 + 会话与安全组：会话信息成行、退出全部设备成危险色行）；退出登录从菜单行移出，置页面最底部、危险色文字按钮
- 账户页：改密与邮箱表单的提交区统一走 .form-actions 右对齐（components.css 新增共享工具类），主按钮换共享 Button 并带 loading；验证码步按钮顺序按「次要在左、主按钮最右」（重新填写邮箱 ghost 在左、确认在右）

## 3. 私有样式清理（线 A 报告 §5 登记中属用户页的部分）

- 私有复制反馈：HomePage、MySubscriptionsPage 两处全迁 CopyButton；SharePage / ShareDrawer 属分享线，未动
- 字重字面量：pages-nav.css 全清（700→--weight-semibold、750→--weight-strong、650→--weight-semibold，含侧栏/dock 激活态与 .nav-menu-item）；pages-apps.css 的 appu-* 全清（750 / 700 / 650 同法）；pages-delivery.css 的 .del-status-card h2 700 已令牌化；pages-expiry.css 的 .exp-status-meta dt 700 已令牌化
- 圆角字面量：.appu-mark 的 12px → var(--radius-card-lg)；pages-nav.css 的 border-radius: 0 与 box-shadow: none 是区块内去框重置值，非设计字面量，保留
- 死规则删除：pages-nav.css 的 .nav-kicker / .nav-actions* / .nav-soon* / .node-summary*（含两处 @media 内的引用，.nav-status-body 的分组选择器已拆出保留）；pages-apps.css 的 .appu-chip-group / .appu-chip-label / .appu-filters .sp-chip
- CLIENT_LABELS 常量从 MySubscriptionsPage 迁至 delivery/platforms.ts 与平台逻辑同处，首页与订阅页共用

## 4. 遗留登记

- 节点页订阅筛选仍用 FilterChip：订阅名长短与数量不定，分段控制会溢出；分组筛选已放在 .node-seg-scroll 滚动容器内，若要统一可待 SegmentedControl 支持滚动形态后再迁
- SegmentedControl 本体无横向滚动/换行处理，平台多时靠页面级滚动容器兜底（.nav-seg-scroll / .del-seg-scroll / .node-seg-scroll / .appu-filters）；平台再增时建议线 A 在组件层加 overflow 支持
- 节点接口只给名称/协议/分组/订阅，无逐节点链接数据，§8 的「行尾图标动作」无可挂载的动作，未私造
- pages-expiry.css 的 .exp-expiry-stat（700/800）只被管理端 DashboardPage 使用，留线 C；pages-delivery.css 的 .del-admin / .del-select-all、pages-apps.css 的 .app-* 字面量同属管理页，留线 C
- 线 A 组件未新增：本次只在 components.css 补了 .form-actions 一个共享工具类（表单底部右对齐），无新组件
