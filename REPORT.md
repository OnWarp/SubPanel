# 域名管理前端重构报告

工作树 `/data/workspace/subpanel-domain-ui`，分支 `task/sub-domain-refactor-ui`，基底 `origin/main` `5c01a9373`。本次只改前端和测试。没有改 `worker/`、`migrations/`、`wrangler.jsonc`，没有部署，没有操作生产 D1，没有使用 `/data/workspace/SubPanel`，没有重装或删除 `node_modules`。

## 修改文件

| 文件 | 大小 | 改动 |
| --- | --- | --- |
| `src/features/system/DomainSettingsSection.tsx` | 41 KB | 重写域名管理：用途标签、主链接 Radio、启用 Switch、行菜单、添加与备注弹窗、验证抽屉 |
| `src/styles/pages-system.css` | 9.6 KB | 紧凑列表、移动端换行、菜单视口限制、移动端全屏抽屉 |
| `src/app/api.ts` | 20 KB | 域名写入与域名限制写入后使 `GET /api/admin/system/domains` 缓存失效 |
| `src/ui/Switch.tsx` | 1.1 KB | 可选 `id` 与 `aria-describedby`，禁用原因可被辅助技术读到 |
| `src/ui/Dialog.tsx` | 11 KB | 可选 `className`，供移动端抽屉覆盖宽度 |
| `src/features/delivery/UserSubscriptionPlan.tsx` | 21 KB | 管理员查看用户订阅时，后端没有链接就显示「订阅链接暂不可用」 |
| `development/tests/browser/system-domains.spec.ts` | 32 KB | 覆盖标签、Radio、Switch、删除保护、验证详情和窄屏 |
| `development/tests/ui/navigation-structure.test.ts` | 16 KB | 分发页标题断言改为「域名管理」 |

外壳（侧栏、底栏、Logo、品牌蓝、导航）没有改。没有新造一套组件，页面继续用 Section、SectionTabs、DetailList、Dialog、ConfirmDialog、Switch、RowActions、FormField、Skeleton、EmptyState、ErrorState、OperationsFooter、CopyButton。

## 界面行为

分发页标题是「域名管理」。访问限制开关和订阅平台展示仍在标签页上方，请求体与原来相同：限制开关 `PUT /api/admin/system/domain-restriction`，平台顺序与开关 `PUT /api/admin/system/subscription-platforms`，成功后用返回的 `platforms` 更新列表。

标签用 SectionTabs，查询参数 `domainKind`。面板域名是默认页，地址不带该参数；订阅域名带 `domainKind=subscription`。其它查询参数会保留。列表区域的可访问名称是当前用途，添加按钮在这个区域里。

主链接是 Radio，只有已验证且已启用的域名可选。切换时整组 Radio 锁定，成功后原主取消选中，启用状态不变，焦点回到刚选中的 Radio。主域名排在最前，其余按 `createdAt` 再按 `id` 稳定排序。启用是 Switch。主域名的开关禁用，旁注「请先切换主链接」。未验证且未启用的开关禁用，旁注「请先验证」。未验证但当前开着的开关只能关掉。

更多菜单是现有 RowActions：复制链接、编辑备注、重新验证、查看详情 / DNS 配置，删除在最后并使用危险色。复制的是 `https://<hostname>`，不是带令牌的订阅地址。主域名的删除按钮禁用。删除前二次确认，说明旧链接将停止服务，且只移除应用层授权，不删除 Cloudflare DNS 或 Worker 绑定。

添加弹窗要求填写域名，备注选填且最多 200 字符，用途取当前标签。服务端返回 `domain` 时打开验证抽屉并请求挑战记录。响应里没有 `domain` 时只重新拉取列表，不打开抽屉，以保持现有添加弹窗测试的成功路径。备注可以清空，请求体是 `{ note: "" }`，弹窗里没有域名输入框。

验证抽屉在桌面从侧边打开，宽度不超过 760px 时铺满对话框视口。内容包括域名、用途、主链接、启用、备注、验证时间、DNS、HTTPS、服务可达性、最近检查和最近错误。TXT 记录名和值在挑战响应返回后才显示，并可复制。确认验证时，浏览器以 `cors`、不带 cookie 请求 `https://<hostname>/api/system/instance`，再把读到的实例标识作为 `observedInstanceId` 提交。关闭抽屉会中止进行中的读取。

探测值 `ok` / `pass` / `passed` / `healthy` / `reachable` / `success` / `verified` 显示「正常」；`failed` / `fail` / `error` / `unreachable` / `unhealthy` 显示「异常」；`pending` / `checking` / `running` 显示「检测中」。缺失、未知、布尔值以及其它形状显示「未检测」，不会显示成正常。对象形式接受 `status`、`state` 或 `ok`。`health.reachability` 当作服务可达性。验证状态用文字和图标一起表示。

加载时有骨架，空列表显示「暂无域名」，列表失败显示服务端原因或网络错误，并提供重试。没有加搜索。域名列表按当前产品规模保持短列表，因此不存在「搜索无结果」状态。

每次操作立即提交。主链接和启用采用乐观更新，失败时恢复该用途原来的列表和主链接，并显示服务端消息。添加、备注和删除在失败时保持弹窗，不编造原因。

## API 契约核对

前端按冻结契约调用，没有改契约去迁就当前后端。

一致的部分：

- `GET /api/admin/system/domains` 不带 `purpose`。冻结契约允许这样一次返回两边列表、两个主链接 id 和 `restrictionEnabled`。标签切换在前端完成。
- `POST /api/admin/system/domains/:kind` 发送 `{ hostname, note }`。备注为空时省略 `note`，与当前后端可选字段以及现有添加弹窗测试一致。
- `PATCH /:kind/:id` 发送 `{ note }` 或 `{ enabled }`。清空备注会发送空字符串。
- `DELETE /:kind/:id` 按 204 处理。
- `POST /:kind/:id/primary` 幂等。请求体是空 JSON 对象 `{}`。
- `PUT /api/admin/system/domain-restriction` 发送 `{ enabled }`。
- `POST /:kind/:id/challenge` 读取 `challenge.txtName`、`txtValue`、`expiresAt`。
- `POST /:kind/:id/verify` 发送 `{ observedInstanceId }`。
- 失败时展示响应里的 `error.message`，覆盖 400、409、422 等状态。

与当前已合入后端的差异（界面仍按冻结契约编写）：

- 当前 `toPublicDomain` 没有 `purpose`、`isPrimary`、`health`。界面用所在列表确定用途，用 `primaryPanelDomainId` / `primarySubscriptionDomainId` 确定主链接。没有健康数据时显示「未检测」。
- 当前公开实例接口返回 `{ instanceId }`。界面同时接受 `observedInstanceId` 和 `instanceId`，提交给 verify 的字段始终是 `observedInstanceId`。
- 健康字段的具体形状冻结契约没有规定。上面的映射是前端解释，未知值不会被当成正常。

## 用户侧审计

只改了一处。其余入口已经使用后端返回的链接，没有改为自选域名，也没有暴露备用域名或备注。

| 位置 | 结论 |
| --- | --- |
| `MySubscriptionsPage.tsx` | 使用 `summary.subscriptionUrl`。为空时显示「订阅链接暂不可用」。`subscriptionFormatLink` 只在已有后端链接时，在该链接后追加 `/<客户端>`，不挑选主机，链接为空时不生成导入项 |
| `MinePage.tsx` 统一订阅 | 同样使用 `subscriptionUrl`，为空时显示「订阅链接暂不可用」 |
| `MinePage.tsx` 旧订阅 | 使用后端 `links`，经 `pickPrimaryLink` 在已返回的链接里选取，没有链接时显示「暂无可用链接」 |
| `LegacySubscriptionsPage.tsx` | 域名未配置时显示后端给出的不可用说明。复制和二维码只在已有主链接时出现 |
| `client-import.ts` | `clientImportLink` 只包装调用方传入的链接。没有链接则返回空 |
| `SharePage.tsx` / 分享弹窗 | 链接来自分享创建或导出接口返回的地址 |
| 公告与 `reminder.ts` | 不拼订阅地址 |
| `UserSubscriptionPlan.tsx` | 管理员复制用户订阅。原先 `subscriptionUrl` 为空时复制按钮隐藏，但没有不可用说明。本次补上「订阅链接暂不可用」。有链接时复制按钮仍在 |

`worker/delivery/unified-routes.ts` 在没有主订阅域名时，仍会用当前请求的 origin 生成 `subscriptionUrl`。这是后端行为，本次按范围没有修改。前端没有再加一层回退。

## 测试

- `npx tsc -p tsconfig.app.json --noEmit` 通过。
- Playwright `system-domains.spec.ts`：10 项通过。Vite 从仓库根目录监听 `127.0.0.1:4173`，`SUBPANEL_EXTERNAL_SERVER=1`。覆盖标签与查询参数、主链接键盘选择与焦点、切换失败回滚、启用开关及 409 回滚、主域名和未验证域名的禁用原因、删除取消与确认、主域名删除禁用、服务端拒绝删除、添加后的挑战记录、实例标识读取与 verify 请求体、422 与无效响应、实例接口失败、备注清空与失败保持、空成功响应不打开抽屉、骨架、空列表、断网、403 后重试、390px 不出现页面横向滚动且菜单留在视口内、窄屏抽屉铺满对话框视口。
- 额外跑了 `modal-p2.spec.ts` 里「domain errors stay in the M dialog until the request succeeds」，1440、1024、390 三个宽度都通过。没有跑完整 Playwright。
- `CI=1 npm test`：69 个文件，554 通过，1 跳过。`d1-domains.test.ts` 通过，因为 worker 未改。
- `data-cache.test.ts`：38 通过。
- `navigation-structure.test.ts`：分发页「域名管理」断言通过。同一文件另有 1 项失败：订阅管理导航期望包含 `/delivery/conversions`，而 `src/app/navigation.ts` 没有这个地址。该文件本次只改了分发页标题字符串，这项失败在基底上就会出现，没有继续追 pages-node、subscriptions-node、templates 三组基线。

加载测试里，若第一次域名读取撞上启动时的会话切换而被缓存层作废，测试会点一次重试。这是现有缓存与会话切换的时序，不是域名接口的业务失败。

## 尚未与真实后端联调

当前分支的 worker 还没有挑战接口，verify 也不读取 `observedInstanceId`。以下调用只在 Playwright mock 中走过，集成时需要后端按冻结契约提供：

- `POST /api/admin/system/domains/:kind/:id/challenge`
- `POST /api/admin/system/domains/:kind/:id/verify`，请求体 `{ observedInstanceId }`
- 列表项上的 `purpose`、`isPrimary`、`health`（界面已能在缺这些字段时工作）
- `GET /api/admin/system/domains?purpose=panel|subscription`（界面当前不发送 `purpose`，用无参数响应）
- 浏览器跨域读取 `https://<hostname>/api/system/instance`。当前接口返回 `{ instanceId }`，本次没有在真实自定义域名上确认 CORS 响应头。若目标域名不返回允许管理端来源的 CORS 头，确认验证会停在「无法连接该域名上的实例标识接口」，不会改用管理端自己的实例标识

没有对生产或本地真实 Worker 做域名联调。

REPORT-READY
