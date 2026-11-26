# SubPanel UIUX 2.0 未知分享令牌整页导航

分支 `task/sub-uiux2-fix2-grok`，起点 `origin/main` `41560a0a4`。工作树 `/data/workspace/subpanel-uiux2-fix2-grok`。本处只修未知分享令牌的整页导航。390 宽模板编辑弹窗与底栏交叠未改。未部署，未碰生产。

## 路由与错误处理现状

`worker/delivery/unified-routes.ts` 的 `GET /s/:token/:client?` 同时承担两件事：浏览器打开分享页，以及订阅客户端拉取配置。`worker/app.ts` 的 SPA 回退明确跳过 `/s` 与 `/sub`，所以这条路由不命中时不会再发应用壳。

修前，只有令牌能查到分享记录、路径没有客户端段、并且 `Accept` 含 `text/html` 时才返回应用壳。未知令牌继续查统一订阅。没有可用授权时抛出 `subscriptionNotFound()`，响应是 JSON 404，错误码 `SUBSCRIPTION_NOT_FOUND`，文案是订阅不存在。浏览器整页打开就只看到这串 JSON。

`SharePage` 的错误处理没有改。令牌不是 43 位分享令牌时，页面进入不可用，标题是链接不可用。43 位令牌会请求 `/api/shares/:token/meta`。接口 404 时仍进入访问验证，标题是访问验证，按钮是验证，页面不显示令牌本身。

旧订阅路径 `/sub/:token` 没有挂上公开订阅路由。SPA 回退也不接管它，响应保持 404，错误码 `NOT_FOUND`，文案是请求的资源不存在。

## 改动

仍在 `GET /s/:token/:client?` 内处理，不改分享接口，不改 `SharePage`。

浏览器文档请求的判定与原来一致：没有客户端路径段，且 `Accept` 含 `text/html`。这类请求在下面三种情况返回同一份应用壳，状态沿用静态资源的 200：

- 令牌格式不合法
- 令牌对应一条已有分享
- 统一订阅模块返回订阅不存在，或账号没有可用且启用的授权

`Accept` 为 `application/json`、没有 `Accept`、或路径带客户端段时，未知令牌仍是原来的 JSON 404，错误码 `SUBSCRIPTION_NOT_FOUND`。格式合法的令牌仍先走原来的频率限制，超限仍是 429。已经启用的订阅令牌即使 `Accept` 含 `text/html`，仍返回订阅文件，不返回应用壳。

本地 Vite 的应用壳带一段内联刷新脚本。文档响应沿用既有 CSP 时，这段脚本会被拦住，分享页停在空白。仅当壳里存在这段 Vite 脚本时，给它的精确 SHA-256 补上 CSP 散列。生产构建的 `index.html` 没有这段内联脚本，仍由中间件套上原来的 CSP。

## curl 对照

本地 Vite `http://127.0.0.1:4173`。D1 已清空并应用到 `0028`，7 个就绪标志为 true。KV 已写入 `system:crypto`。对照在服务进程内完成，密钥未入库。

| 请求 | 状态 | 结果 |
| --- | --- | --- |
| `Accept: text/html`，`/s/unknowntoken0001` | 200 | `text/html` 应用壳，`Cache-Control: private, no-store` |
| 浏览器常见 `Accept`，同一短令牌 | 200 | 应用壳 |
| `Accept: text/html`，43 位未知令牌 | 200 | 应用壳 |
| `Accept: text/html`，`/s/doesnotexist1234567890` | 200 | 应用壳 |
| `Accept: application/json`，短令牌 | 404 | `SUBSCRIPTION_NOT_FOUND`，订阅不存在 |
| `Accept: application/json`，43 位未知令牌 | 404 | `SUBSCRIPTION_NOT_FOUND` |
| 不带 `Accept`，短令牌 | 404 | `SUBSCRIPTION_NOT_FOUND` |
| `Accept: text/html`，`/s/unknowntoken0001/mihomo` | 404 | `SUBSCRIPTION_NOT_FOUND` |
| `Accept: text/html`，`/sub/unknowntoken0001` | 404 | `NOT_FOUND`，请求的资源不存在 |
| `Accept: application/json` 或不带 `Accept`，旧订阅路径 | 404 | `NOT_FOUND` |
| `Accept: text/html`，有效分享令牌 | 200 | 应用壳 |
| `Accept: application/json`，有效分享令牌 | 404 | `SUBSCRIPTION_NOT_FOUND` |
| `Accept: text/html`、`application/json` 或不带 `Accept`，有效订阅令牌 | 200 | `text/plain` 订阅文件 |
| `Accept: text/html`，该订阅令牌的 `/sub/` 旧链接 | 404 | `NOT_FOUND` |

Chromium 打开后的页面：短未知令牌标题为链接不可用。43 位未知令牌标题为访问验证，可见验证与登录后查看，正文没有令牌，也没有 `SUBSCRIPTION_NOT_FOUND`。有效分享显示节点 1 个、复制订阅链接和客户端导入。

## 测试结果

`npm run check`：63 条警告，0 错误。警告是既有的 effect 内 setState。`worker-configuration.d.ts` 未过期。

`npm run build`：通过。客户端主 JS `index-DgtETQK1.js` 为 694.58 KB，gzip 199.79 KB。样式 `index-D15xiSnf.css` 为 162.53 KB，gzip 26.44 KB。

vitest 主套 `npm test`：69 个文件，554 通过，1 跳过。跳过项是原有兑换并发用例。相对基底 553 通过，多出的 1 条是本线新增的未知令牌文档与 JSON 对照。

`vitest.controls`：36 通过，0 失败。

三组补充配置与基底失败名一致，没有新增失败：

- pages-node：235 通过，1 失败。`navigation-structure` 的「keeps 订阅管理导航 visible across its routes and highlights the current page and domain」仍期望含 `/delivery/conversions`
- subscriptions-node：8 通过，5 失败。`subscriptions.test.ts` 四项公开拉取得到 500，期望分别是 200、404、410，以及分享范围被拒绝「请选择可用的分享范围」。`templates-lifecycle` 一项仍期望发布结果包含 `https://rules.example/ads.yaml`
- templates：92 通过，1 失败，与上面同一条模板生命周期断言

Playwright 使用仓根 Vite `127.0.0.1:4173` 与 `SUBPANEL_EXTERNAL_SERVER=1`。`phase4-business.spec.ts` 1 项通过，20 步全部通过，其中 `share-unknown` 通过。全套 37 项旧失败未重跑。`development/screenshots/` 已用 `git checkout` 还原。

SUB_UIUX2_FIX2_GROK_DONE
