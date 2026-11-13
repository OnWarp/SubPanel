# SubPanel APP 下载模块重构报告

分支：`task/app-refactor-sub`（基线 ea440ba）；方案依据：`SubPanel_APP.md`，冲突以方案为准。

## 一、改造前现状盘点

- 数据模型（迁移 0001）：`apps` 带 icon/summary/description/category/official_website/developer/is_recommended/is_official/is_popular/is_enabled/is_public 等十六列；`app_platforms` 带 version/download_type/file_size_kb/official_store_url/official_download_url/update_notes/import_* 等十七列；无 documentation_url、无平台 sort_order、无 UNIQUE(app_id, platform)。
- 后端：快照模型（appsSnapshotSchema＋system_settings 中的 apps_schema_version/apps_revision/apps_updated_at/next_app_id/next_platform_id/apps_entity_order 元数据），worker/apps/repository.ts 按 `apps_d1_ready` 在 KV/D1 二选一；管理员 API 是 APP 与平台两套独立 CRUD，用户 DTO 带 flags、icon、一键导入字段与订阅联动。
- 前端：管理员页 src/features/catalog/AppsPage.tsx（844 行，旧模型，含分类/开发者/版本/导入模板编辑），用户页 src/features/apps/AppsPage.tsx（498 行，含一键导入与订阅联动）；用户导航（AppShell 的 userSheetItems/userSidebar）与首页有到 /apps 的固定入口。
- 生产数据（盘点时）：apps 1 条、app_platforms 0 条。

## 二、改造内容

### 数据迁移 0006_app_downloads_refactor.sql

- apps 重建为 id/name/description/enabled/sort_order/created_at/updated_at；app_platforms 重建为 id/app_id（外键 ON DELETE CASCADE）/platform（枚举 CHECK）/download_url/documentation_url（可空）/sort_order/时间戳，并加 UNIQUE(app_id, platform)。
- 整形规则：description 取旧 summary、为空时回退旧 description；enabled = 旧 is_enabled AND is_public；平台候选只取旧 is_enabled=1 行；下载链接按 download_url → official_download_url → official_store_url 逐级回退取第一个非空值，且必须以 `https://` 开头才保留；同 (app_id, platform) 重复时按 created_at、id 取最早一条；平台 sort_order 按 windows 0、macos 1、android 2、ios 3、linux 4；documentation_url 旧数据无来源，一律 NULL；最后把 name 为空或无存活平台的 APP 置 enabled=0；system_settings 的 `apps_entity_order` 中 platforms 数组同步修剪为只含存活平台 id（保持原序），避免快照顺序校验报 corrupt。
- 实现注意：D1 强制外键，旧 app_platforms 对 apps 有 ON DELETE CASCADE，直接 DROP 旧 apps 会先级联清空平台行。故迁移先把整形后的平台行落入无外键的暂存表 app_platforms_migration_stage，再重建 apps，最后建正式 app_platforms 并回灌、删除暂存表。此坑由新增迁移测试在 workers D1 环境中实际抓到（桌面 SQLite 默认不开外键、复现不出）。

### 后端

- worker/apps/schema.ts 重写：平台枚举 windows/macos/android/ios/linux 与固定顺序 PLATFORM_ORDER；写入校验仅接受 https 下载/文档链接（≤2048 字符、无空白与反斜杠）；appWriteSchema 为整体保存（APP 字段＋1–5 条平台配置，同 APP 平台不可重复）。
- worker/apps/service.ts 改为整体保存语义：createApp/updateApp 一次写入 APP 与全部平台（更新时按平台名匹配保留平台 id 与创建时间），setAppEnabled 启停，deleteApp 级联删平台；旧的分平台 CRUD 与 PLATFORM_NOT_FOUND 语义删除。
- worker/apps/routes.ts：管理员 GET / 回嵌套形（apps 内嵌 platforms），POST / 建、PUT /:id 整体改、POST /:id/enabled 启停、DELETE /:id 删；用户 GET / 与 GET /:id 先查总开关，关时列表回 `{downloadsEnabled:false, apps:[]}`、详情 404，响应中零 APP 数据泄露；开时只回 enabled 的 APP 与 https 平台，零可见平台的 APP 不返回。
- 总开关：worker/db/settings-repository.ts 新增 `show_app_downloads`（getShowAppDownloads 无值默认 true、putShowAppDownloads），worker/system/routes.ts 新增管理员 GET/PUT `/api/admin/system/app-downloads`。
- worker/migration/apps.ts（KV→D1 一次性导入转换器）同步改为新形，只认新形快照；worker/apps/d1-repository.ts 按新列读写。

### 前端

- 管理员 APP 页重写：列表（名称＋简介截断、平台标签、启用状态、排序、更新时间）＋搜索＋启用筛选；新增/编辑共用抽屉表单（名称必填、简介、启用、排序、平台配置行：平台下拉、下载链接必填、文档链接选填、排序，可增删行），前端校验与服务端一致（≥1 平台、不重复、仅 https），整体保存；行内快捷启停；删除走二次确认。
- 用户 APP 页重写：拉 GET /api/apps，downloadsEnabled=false 时只显示「APP 下载暂未开放」提示、不渲染任何 APP 数据；平台分类标签固定顺序 Windows、macOS、Android、iOS、Linux，默认 Windows（不读 UA）；卡片只有默认图标、名称、简介、下载按钮（新窗口打开，rel="noopener noreferrer"），documentationUrl 有才显示「使用说明」入口；空分类提示「暂时没有可用的 APP」；一键导入、版本、分类、开发者、订阅联动全部移除。
- 系统管理页新增「APP 下载」分区：显示 APP 下载板块开关，即时保存＋toast 反馈，说明文案按方案 §6。
- 导航收口：AppShell 中非管理员且开关关时隐藏用户侧栏与抽屉里的「APP 下载」；首页两处到 /apps 的入口链接同样条件隐藏；管理员不受影响。可见性判断收敛到 src/features/apps/downloads-visibility.ts（模块级缓存，一次页面加载只拉一次）。

## 三、迁移整形统计与异常清单

迁移整形的一般异常类（由 0006 的规则处理，测试夹具逐项覆盖）：

- 同 (app_id, platform) 重复平台行：只保留最早一条，其余丢弃。
- 非 https 下载链接（含 http、缺失且回退链走完仍为空）：平台行丢弃。
- 旧 is_enabled=0 的平台行：不迁移。
- 下载链接缺失：按 download_url → official_download_url → official_store_url 回退链取值。
- 旧 is_public=0 的 APP：迁移后 enabled=0。
- name 为空或迁移后无任何存活平台的 APP：强制 enabled=0，保留行与数据供管理员处理。

生产实况（盘点时点）：apps 1 条、app_platforms 0 条。该 APP 没有任何平台行，应用 0006 后必然无存活平台，按规则置 enabled=0 —— 这是生产异常清单的唯一实况条目；管理员后续在 APP 管理页为其补平台配置再启用即可。生产 0006 由合并后另行应用，不在本分支执行。

## 四、测试与验证

- 新增 development/tests/worker/d1-apps-refactor.test.ts（9 条）：0006 整形（列序、UNIQUE、回退链、去重、非 https 与停用平台过滤、无平台/未公开 APP 停用、entity_order 修剪）、管理员整体保存 CRUD 与 422 校验组、成员 403、启停与级联删除、用户侧可见性、开关关闭时零泄露与恢复、仓储往返。
- 改写 development/tests/worker/migration-apps.test.ts（转换器新形，仍 3 条）、d1-catalog-apps.test.ts 的 apps 夹具、apps-api.test.ts 的 3 条旧模型测试（按新 API 语义改写：整体保存、https-only 校验、用户只见 enabled APP 与精确 DTO 键集）。
- 全量测试：357 条全部通过；smoke.test.ts 套件因 `_headers` ENOENT 无法加载（0 条用例，既有环境问题，简报已注明除外），与本次改动无关。基线 348 条无回退，净增 9 条。
- `npm run check` 退出码 0（仅余 1 条既有未用导入警告，非本次文件）；`npm run build` 退出码 0。

## 五、偏差与说明

- 快照 schemaVersion 仍为字面量 1：快照外形随新模型变化，但版本号是既有元数据字段，未在本阶段升版。
- KV→D1 一次性 apps 导入路径只认新形快照：生产导入早已完成且 `apps_d1_ready` 已置位，不会再重跑，无实际影响。
- official_store_url 纳入下载链接回退链末位：旧形中商店链接是唯一可能的下载入口来源，丢弃会误伤仅填商店链接的存量配置。
- 旧分平台 CRUD 端点（POST/PUT/DELETE /api/admin/apps/:id/platforms…）由整体保存取代，前端与测试已同步。
- 外部 URL 只存不抓：全链路没有任何对下载/文档链接的出站请求，符合出站纪律。
