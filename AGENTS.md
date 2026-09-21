# AGENTS.md

## 项目概述

OpenCode 插件 `opencode-tencent-auth`，同时支持 CodeBuddy / WorkBuddy 的国内版与国际版（4 个 provider）IOA 认证与请求拦截。源码入口 `src/index.ts`，构建到 `dist/`。

## 构建

```bash
npm install && npm run build   # tsc 编译到 dist/
```

无测试、无 lint、无 CI。只有 `npm run build`。发布走 `.github/workflows/publish.yml`：推 `v*` tag 触发，校验 tag 与 `package.json` 版本一致、阻止重复版本，`npm ci && npm run build` 后 `npm publish`。使用 **npm Trusted Publishing（OIDC）**：需 `permissions.id-token: write`、Node ≥ 22.14（workflow 用 24），**不设 `NPM_TOKEN`**；provenance 自动生成。注意 Trusted Publishing 要求包已存在，故首次发布必须手动 `npm publish`，并在 npmjs.com 包设置里绑定 GitHub Actions（user `sososdk`、repo `opencode-tencent-auth`、workflow `publish.yml`）。`repository.url` 必须与仓库一致。

## 架构要点

- 单个共享工厂 `TencentAuthPlugin(input, options)`（`src/index.ts`），`options.provider` 决定服务哪个 provider，默认 `codebuddy`。
- `src/provider/{codebuddy,codebuddy-intl,workbuddy,workbuddy-intl}.ts` 是 4 个本地入口，各自 default export `{ id, server }`，server 用固定 `{ provider }` 调用共享工厂。
- `src/server.ts` 是 npm 入口（`exports["./server"]`）：**不**导出 v1 默认对象，只具名导出 4 个插件函数。原因：opencode 对 npm 插件按**包名**去重（子路径会折叠），但 `getLegacyPlugins()` 会把模块的每个函数导出当作独立实例加载。此文件禁止出现非函数导出（loader 会对非函数导出抛 TypeError）。
- 之所以拆分本地多入口：opencode 的 auth hook 每个插件实例只支持一个 `auth.provider`（`packages/opencode/src/provider/auth.ts` 以 provider id 为 key 聚合所有插件的 hooks），而本地插件会按 file URL 去重（`config/plugin.ts` 的 `deduplicatePluginOrigins`），所以必须用 4 个不同路径的入口注册 4 个 provider。
- `package.json` 的 `exports`：`./server` → `dist/server.js`（npm 唯一入口），`./{provider}` 子路径仅为兼容/参考；`files: ["dist"]`；`prepare` 构建 dist 以便 git 安装。
- 运行时每个实例通过 `auth.loader` 返回自定义 `fetch` 拦截 `/chat/completions`，注入 IOA 认证 headers。

### 核心 Hooks（每个实例各一份，只作用于自己的 provider id）

1. **config** — 创建 `provider.<id>`（`npm: @ai-sdk/openai-compatible`，baseURL `{serverUrl}/v2`）；从 `~/.local/share/opencode/auth.json` 读取本 provider 的 token 拉取模型目录注入；未登录或失败 fallback 为 `DEFAULT_MODEL`（仅 `id/name/supportsToolCall/supportsImages`，**刻意不带 `limit`**，避免用硬编码上下文长度触发错误的自动压缩）；不覆盖已声明 models。
2. **auth** — IOA OAuth（浏览器 → 轮询 token），`provider` 为实例 id。
3. **chat.params** — `input.model.providerID === 本 id` 时设置 `output.options.baseURL`。

### X-Domain 决策

优先级：`${PREFIX}_DOMAIN` 环境变量 > 登录 JWT 的 `iss` hostname（`new URL(iss).hostname`）> provider 兜底。禁止按 baseURL 推断。

`resolveEnterpriseId()` 依次从 JWT `realm_access.roles` 匹配 `^(?:ent-member|ent-admin|ent-plugin-enabled|group-admin):([A-Za-z0-9-]+)$`，再回退 `enterprise_id` 等声明。WorkBuddy 企业账号的角色形如 `ent-member:fwxfye7ismps`，企业 ID 用于 console 目录地址与企业版模型。`resolveTenantId()` **直接返回 `resolveEnterpriseId()`**：客户端 `X-Tenant-Id` 与 `X-Enterprise-Id` 同值（均取 `account.enterpriseId`），不存在独立的 `sso-<tenant>` 来源。

### Provider 表（src/index.ts 顶部 `PROVIDERS`）

- `codebuddy` → `https://copilot.tencent.com`，兜底 `www.codebuddy.cn`，env 前缀 `CODEBUDDY`
- `codebuddy-intl` → `https://www.codebuddy.ai`，兜底 `www.codebuddy.ai`，env 前缀 `CODEBUDDY`
- `workbuddy` → `https://www.workbuddy.cn`，兜底 `www.workbuddy.cn`，env 前缀 `WORKBUDDY`
- `workbuddy-intl` → `https://www.workbuddy.ai`，兜底 `www.workbuddy.ai`，env 前缀 `WORKBUDDY`

环境变量：`${PREFIX}_TENANT_ID/_ENTERPRISE_ID/_USER_ID/_DEFAULT_MODEL/_DOMAIN`。

每个 spec 的客户端身份字段（均经逆向已安装客户端核对）：

| 字段 | codebuddy(-intl) | workbuddy(-intl) | 说明 |
|---|---|---|---|
| `ideType`/`ideName` | `CodeBuddyIDE` | `WorkBuddy` | 真实客户端 `product.platform`；不放 `X-IDE-Type` 的客户端会缺省该值 |
| `userAgent` | `VSCode/1.119.0 CodeBuddy/4.9.29177644` | `WorkBuddy/<clientVersion>` | **CodeBuddy 服务端要求 UA 含 `VSCode/`**，纯 `CodeBuddy/<ver>` 会返回空模型；WorkBuddy 接受自身 UA |
| `clientVersion` | `4.9.29177644` | `5.5.6` / `5.5.2` | 取自 `genieVersion`；用于 `X-IDE-Version` 与 `X-Product-Version`，为空则两头发 |
| `modelAgentName` | `craft` | `cli` | 从 `/v3/config` 取模型目录用的 agent 名 |
| `headerAgentIntent` | `craft` | `craft` | `X-Agent-Intent` 头；真实 CLI 恒为 `craft`，与上者**不是**同一概念 |
| `authPlatform` | `ide` | `workbuddy` / `workbuddy-ai` | `/v2/plugin/auth/state?platform=`；取自 `product.authentication.attributes.platform` |

### 请求细节

- 对话 headers：`buildStaticHeaders()`（Authorization、X-Domain、X-Agent-Intent、X-Product、User-Agent 等）+ `applyIdentityHeaders()`（X-Tenant/Enterprise/User-Id）+ B3 追踪/X-Model-ID，合并为 `buildAuthHeaders()`；模型发现复用 `buildStaticHeaders()` + `applyIdentityHeaders()`。X-Domain 每次从当前 access token 的 iss 计算。`X-IDE-Version`/`X-Product-Version` 仅在 `spec.clientVersion` 非空时发送。
- 登录使用共享常量 `LOGIN_NO_AUTH_HEADERS`（`X-No-*` 头集）。
- token 刷新 `/v2/plugin/auth/token/refresh`：真实客户端 Header —— `Authorization: Bearer <access>`、`X-Refresh-Token: <refresh>`、`X-User-Id`、`X-Auth-Refresh-Source: plugin`、`X-Product: SaaS`、`X-Domain`，body `{}`。
- 登录：`POST {serverUrl}/v2/plugin/auth/state?platform={spec.authPlatform}&ioa=1`（X-No-* 头）→ 轮询 `GET {serverUrl}/v2/plugin/auth/token?state=`。轮询期间非 200 / `code !== 0` / 网络异常都会 `console.warn` 打出，不静默吞掉（超时 10 分钟）。
- 模型发现：分两路并发拉取后按 provider 合并（`fetchConfig` + `fetchCatalog`）：
  - `fetchConfig` → `GET {serverUrl}/v3/config`（需 access token），取 `models[]` 作为模型元数据补充源。
  - `fetchCatalog` → 仅 `spec.catalogUrl` 存在时请求（当前只有 workbuddy 国内版：`/console/enterprises/{enterpriseId}/models`，`{enterpriseId}` 按 JWT 角色解析，缺省 `personal`）。作为 agent 模型顺序（`cli`）与目录主来源。
  - 合并规则：agent 模型顺序取 `primary`（有 catalog 时用 catalog，否则 config）中 `spec.modelAgentName` agent 的 `models`；模型元数据先铺 `secondary` 再用 `primary` 覆盖。`X-Agent-Intent` 头固定用 `spec.headerAgentIntent`（恒为 `craft`）。
  - **WorkBuddy Auto 三档**：workbuddy 国内版启用 `AutoModelTiers` 时，`auto` 被替换为内置三档 `fast-model`/`balanced-model`/`deep-model`（`AUTO_TIER_MODELS`，元数据对齐客户端内置定义：x0.21/x0.65/x1.20，300K/48K），并置于目录最前，与客户端 `replaceAutoWithTierModels` 行为一致。这三档若 `/v3/config` 未下发则由内置常量补齐。国际版 `/v3/config` 自带 `default-model` + 四档（`fast/balanced/primary/deep-model`），无需本地展开。
  - 真实客户端推理走 lkeap Token Plan 网关（`api.lkeap.cloud.tencent.com`），与插件可用的设备 `/v2` 通道不互通（IOA token 401），勿改用。
- 图片支持（PR #4 保留）：`remoteModelToConfig()` 在 `supportsImages` 时写 `attachment: true` + `modalities = { input: ["text","image"], output: ["text"] }`。
- 模型显示名：`remoteModelToConfig()` 生成 `名称 (倍率 · 上下文)`，倍率取 `credits`（去掉尾部 ` credits`），上下文由 `formatContext()`（`maxInputTokens` → `1M`/`256K` 等）；两者都没有则用原名。`limit.context/output` 仍完整写入供 opencode 使用。
- 积分余额（`fetchCredits()`，`config` hook 中与模型发现并发，超时同 `DISCOVERY_TIMEOUT_MS`）：按 `resolveEnterpriseId()` 是否有值分两路，成功后把结果拼进 `config.provider[id].name`（如 `WorkBuddy · 积分 910.56/2000`，无 UI 槽位故用 provider 显示名承载）：
  - 企业账号：`POST {serverUrl}/v2/billing/meter/get-enterprise-user-usage`（带身份头，含 `X-Enterprise-Id`），取 `data.credit`（剩余）/`data.limitNum`（总额，`-1` 表示不限）。
  - 个人账号：`POST {serverUrl}/billing/meter/get-user-resource-summary`（**无 `/v2` 前缀**，国际版 `www.*.ai` 只有此路径，带 `/v2` 会 404），累加 `data.Packages[].CycleRemainCapacity`（剩余）/`CycleTotalCapacity`（总额），单位为 credit。
- 账号名称（`resolveAccountName()`，纯本地解 JWT，无需请求）：按 `nickname` → `preferred_username` → `name` → `email` 取第一个非空值。国内版为 `nickname`（手机号），国际版无 `nickname`/`name`，回退 `email`。与积分一起拼进 `config.provider[id].name`，顺序为 `{spec.name} · {账号} · {积分}`（如 `WorkBuddy · 18924640874 · 积分 910.56/2000`）。
- 未登录或请求失败时 `fetchCredits` 返回 `null`，积分段省略；账号解析失败则账号段省略，provider 名至少保留 `spec.name`。

## 环境

- 配置文件：`~/.config/opencode/opencode.jsonc`（4 个本地 entry 注册，绝对路径 `dist/provider/*.js`；勿加手动 `provider` 块）。
- Token 存储：`~/.local/share/opencode/auth.json`，按 provider id 分槽。
- 机器无系统 Node，用 `/opt/node/bin`（PATH 需 export）。
- 验证命令：`opencode providers login --provider <id>`（会打印 auth URL 并阻塞轮询，用 timeout 包裹）；4 主机 auth/state 均已 curl 验证 200。