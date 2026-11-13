# SubPanel D1 第九批报告：界面收口（系统设置页）

基线 4b585b7，分支 `task/d1-system-ui-sub`。原先只有空壳的管理员「系统管理」页（`/system`）现落地为四个分区的设置页：账号与注册、邮件设置、分享设置、系统状态。

## 新增后端接口（worker/system/）

| 接口 | 说明 |
|---|---|
| `GET /api/admin/system/registration` | 返回当前注册模式 `{ mode }` |
| `PUT /api/admin/system/registration` | 即时保存注册模式（closed / invite / open），校验失败 422 |
| `GET /api/admin/system/mail` | 返回邮件设置，敏感字段只回 `smtpPasswordSet` / `resendApiKeySet` 布尔，永不回明文 |
| `PUT /api/admin/system/mail` | 部分更新；敏感字段缺省或空串＝保留已存值，非空才覆盖（只写语义） |
| `GET /api/admin/system/status` | 只读：D1 库名、五模块当前后端（kv/d1）＋schema 版本＋迁移记录列表 |

全部经 `app.route('/api/admin', adminSystemRoutes)` 注册，走既有管理员会话鉴权。

## 分区与设置键对照

### 账号与注册
- 注册模式三档（关闭注册 / 仅邀请 / 开放注册）：读写 `worker/db/settings-repository.ts` 既有的 `getRegistrationMode` / `putRegistrationMode`（键 `registration_mode`，默认 invite），前端选中即 PUT 保存，无单独保存按钮。
- 邮箱域名白名单子区：调第六批接口 `/api/admin/email-domains`（见「未就绪项」）。

### 邮件设置（新键，逐键存 system_settings，经 settings-repository 的 getSetting/putSetting）

| 前端字段 | 设置键 | 敏感 |
|---|---|---|
| 发送方式（SMTP / Resend） | `mail_provider` | 否 |
| 发件人 | `mail_from` | 否 |
| SMTP 主机 | `mail_smtp_host` | 否 |
| SMTP 端口 | `mail_smtp_port` | 否 |
| SMTP 用户名 | `mail_smtp_user` | 否 |
| SMTP 密码 | `mail_smtp_pass` | 是（只写；留空不覆盖；读取只回是否已设置） |
| Resend API Key | `mail_resend_api_key` | 是（只写；留空不覆盖；读取只回是否已设置） |

- 纯函数在 `worker/system/mail-settings.ts`：`assembleMailSettings`（原始键值→设置）、`applyMailSettingsPatch`（补丁合并，空敏感值保留旧值）、`toPublicMailSettings`（脱敏形状），均有单测。
- 这批只落「设置存储与界面」；实际发送仍走第五批在 `worker/accounts/email.ts` 的投递抽象，后续由第五批把投递器改为读这组设置键即可，本批不接管发送路径。
- 测试邮件按钮调第五批接口 `POST /api/admin/mail/test`（见「未就绪项」）。

### 分享设置
- `src/features/system/ShareSettingsSection.tsx`：把原 `AdminSharesPage` 的全局策略编辑器（分享开关、创建权限、默认原始链接/要求登录、公开页地址）整体迁入系统页，接口不变（`GET/PUT /api/admin/share-settings`，后端未动）。
- `AdminSharesPage` 原「全局策略」区已移除，保留一个跳转入口（说明文字＋「前往系统管理」按钮链到 `/system`），其余分享列表功能不变。

### 系统状态（纯只读，无任何写控件）
- `worker/system/status.ts`：`assembleModuleStatuses` 按五模块的 `*_d1_ready` 标记（catalog / apps / delivery / shares / accounts；本批为 delivery、shares 补了 `module-switch.ts` 常量）与 `*_schema_version`、`state:<module> updatedAt` 组装状态；迁移记录读 D1 的 `d1_migrations` 表（读失败回空列表不报错）。
- 数据库名以常量 `DATABASE_NAME = 'subpanel-d1'` 呈现（与 wrangler.jsonc 的 D1 绑定一致，代码注释已注明）。

## 未就绪项（基线缺失，按简报口径处理，未代造接口）

| 依赖 | 所属批次 | 本批处理 |
|---|---|---|
| `GET/POST/DELETE /api/admin/email-domains` 基线不存在（仅 migrations 里有 `allowed_email_domains` 表） | 第六批 | 域名白名单分区先调该接口；返回 404 时显示「邮箱域名白名单接口未就绪（等待第六批）」占位，其他错误走 toast。第六批接口落地后此分区自动可用（前端兼容 domains 为字符串数组或 `{ domain }` 对象数组两种形状） |
| `POST /api/admin/mail/test` 基线不存在 | 第五批 | 「发送测试邮件」按钮先接该接口；404 时 toast 提示「测试邮件接口未就绪（等待第五批）」 |

## 验证结果

- 新增测试 `development/tests/worker/d1-system-settings.test.ts` 10 条全过：注册模式默认/保存/非法 422/匿名 401；邮件默认形状；密钥只写全流程（响应与 GET 均不含明文、空补丁保留、非空替换、直接查 D1 原始键值断言）；非法端口/服务商 422；纯函数（空值保留、脱敏形状、状态组装）；状态接口全 KV 默认与置位后反映。
  - 注：状态接口的集成测试刻意不置 `accounts_d1_ready`——置位会把会话解析切到空的 D1 users 表、使测试自身的管理员会话失效；accounts 的置位反映由组装纯函数单测覆盖。
- 全量测试：288 条全过（基线 278＋新增 10），无回退。唯一 failed suite 是基线既有环境问题 `smoke.test.ts` 加载 `../../public/_headers` ENOENT（worktree 无 public 目录），与简报排除项一致。
- `npm run check` 全绿（wrangler types --check、tsc -b、oxlint 0 warnings 0 errors）。
- `npm run build` 成功。
