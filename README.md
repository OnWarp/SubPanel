# SubPanel

基于 Cloudflare Workers + KV 的代理节点聚合与订阅分发面板。支持多来源导入、节点整理、分组编排、多用户订阅和常见客户端格式输出。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kadidalax/SubPanel)

## 功能

- 来源：手动录入、本地文件、HTTPS 远程订阅和定时刷新。
- 导入：URI、Base64、v2rayN/v2rayNG、Mihomo/Clash、sing-box、SIP008、Surge、Loon、Quantumult X。
- 管理：节点搜索与筛选、启停、保留、分组包含/排除和节点排序。
- 分发：Mihomo、sing-box、Surge、Loon、Quantumult X、v2rayN、NekoBox、Shadowrocket 和通用 URI。
- 账户：单管理员、多普通用户、邀请注册、密码管理和订阅令牌重置。
- 界面：响应式管理面板、浅色/深色/跟随系统主题。

## 一键部署

点击上方 **Deploy to Cloudflare**，登录 Cloudflare 并授权仓库。Cloudflare 会自动构建 Worker、上传静态资源并创建 `DATA` KV 绑定，不需要配置环境变量或 Secret。

部署完成后打开 Worker 地址。首次访问会进入管理员创建页，请设置管理员用户名和至少 12 位的密码。系统创建管理员后会永久关闭初始化入口。

## Cloudflare 面板关联 GitHub

需要由 Cloudflare 在每次推送后自动部署时：

1. 打开 Cloudflare Dashboard 的 **Workers & Pages**。
2. 选择 **Create application**，然后选择 **Import a repository**。
3. 授权 GitHub 并选择 `kadidalax/SubPanel`。
4. 生产分支填写 `main`，根目录保持 `/`。
5. 构建命令填写 `npm run build`。
6. 部署命令填写 `npx wrangler deploy`。
7. 不添加环境变量，保存并开始部署。

仓库中的 [`wrangler.jsonc`](wrangler.jsonc) 已包含静态资源、KV、Cron 和可观测性配置。后续推送到 `main` 会触发新的生产部署。

## 本地开发

要求 Node.js LTS、npm 和可用的 Cloudflare 账号。

```powershell
npm ci
npm run dev
```

打开终端显示的本地地址，首次访问时创建管理员。本地 KV 数据保存在 `.wrangler/`，不需要 `.env` 或 `.dev.vars`。

## 验证与部署

```powershell
npm run check
npm test
npm run test:e2e
npm run deploy
```

也可以只验证部署包：

```powershell
npm run build
npx wrangler deploy --dry-run
```

健康检查接口：`/api/health`。远程来源刷新 Cron 为每 15 分钟执行一次，每次最多刷新一个到期来源。KV 为最终一致存储，订阅令牌重置或远程刷新可能需要短暂时间在所有地区生效。

## 技术栈

- React 19、React Router、Vite
- Hono、Cloudflare Workers、Workers KV
- TypeScript、Zod、Vitest、Playwright

## 说明

- 单实例只允许一个管理员。
- Catalog 最多保存 100 个逻辑节点。
- 首次初始化采用先到先得；部署后应立即创建管理员。
- 项目按当前实现提供，不承诺所有客户端私有字段都能无损输出；无法输出的内容会在兼容诊断中说明。
