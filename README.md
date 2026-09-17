# opencode-tencent-auth

OpenCode 插件：为腾讯 **CodeBuddy** / **WorkBuddy** 的 **国内版** 与 **国际版**（共 4 个 provider）提供 IOA 浏览器登录与请求认证。登录一次后即可在 OpenCode 中使用对应产品的对话模型，模型列表、积分倍率、上下文长度全部自动发现，并支持图片输入。

> ⚠️ 非官方插件。所对接的是客户端内部接口，官方未承诺兼容性，请自用、风险自负。

## 特性

- **4 个 provider 独立槽位** —— 每个产品/环境一个 provider id，token、模型、请求互不干扰
- **浏览器 OAuth 登录** —— `opencode providers login` 打开对应主机 IOA 登录页，自动轮询换取 token
- **自动 token 刷新** —— 对话返回 401/403 时用真实客户端 Header 刷新并重试，无需重新登录
- **自动模型发现** —— 启动时按 provider 拉取可用模型；显示名附带官方积分倍率与上下文长度（如 `Hy4 preview (x0.29 · 1M)`）
- **图片输入** —— 服务端标记 `supportsImages` 的模型自动开启 `attachment` 与多模态 modalities
- **X-Domain 自动推导** —— 优先环境变量，其次登录 token 的 `iss` 主机名，最后 provider 兜底

## 支持的 Provider

| Provider ID | 产品 | 环境 | Server (API) | X-Domain 兜底 | 环境变量前缀 |
|---|---|---|---|---|---|
| `codebuddy` | CodeBuddy | 国内版 | `https://copilot.tencent.com` | `www.codebuddy.cn` | `CODEBUDDY_` |
| `codebuddy-intl` | CodeBuddy | 国际版 | `https://www.codebuddy.ai` | `www.codebuddy.ai` | `CODEBUDDY_` |
| `workbuddy` | WorkBuddy | 国内版 | `https://www.workbuddy.cn` | `www.workbuddy.cn` | `WORKBUDDY_` |
| `workbuddy-intl` | WorkBuddy | 国际版 | `https://www.workbuddy.ai` | `www.workbuddy.ai` | `WORKBUDDY_` |

每个 provider 使用**固定 server**，不会根据 baseURL 推断环境。

## 安装

### npm（推荐）

在 `~/.config/opencode/opencode.jsonc` 加入一行即可注册**全部 4 个 provider**：

```jsonc
{
  "plugin": ["opencode-tencent-auth"]
}
```

OpenCode 启动时会用 Bun 自动安装并缓存到 `~/.cache/opencode/node_modules/`。

> 为什么一行就行？OpenCode 对 npm 插件按**包名**去重，因此一个包只能被加载一次。本包的 npm 入口（`exports["./server"]`）不导出 v1 `{ id, server }` 默认对象，而是**具名导出 4 个插件函数**——OpenCode 的 legacy 加载路径会把每个函数导出当作独立插件实例，从而在一个包里注册 4 个 provider。副作用：npm 安装会同时启用全部 4 个 provider（登录哪一个用哪一个）。

### 本地开发

本地克隆后，按需把入口文件加入配置（绝对路径）：

```jsonc
{
  "plugin": [
    "/absolute/path/to/opencode-tencent-auth/dist/provider/codebuddy.js",
    "/absolute/path/to/opencode-tencent-auth/dist/provider/codebuddy-intl.js",
    "/absolute/path/to/opencode-tencent-auth/dist/provider/workbuddy.js",
    "/absolute/path/to/opencode-tencent-auth/dist/provider/workbuddy-intl.js"
  ]
}
```

本地文件按**文件路径**去重，所以可以用四个独立入口精确选择需要的 provider。`config` hook 会自动创建对应的 `provider` 与 `models`，**不要**再手写 `provider` 块。

## 登录

```bash
opencode providers login --provider codebuddy
opencode providers login --provider codebuddy-intl
opencode providers login --provider workbuddy
opencode providers login --provider workbuddy-intl
```

浏览器会打开对应主机的 IOA 登录页，完成后控制台打印 `login success (X-Domain=...)`，token 按 provider id 分别存入 `~/.local/share/opencode/auth.json`。

## 模型与费率

登录后 `config` hook 自动拉取模型（未登录或拉取失败时 fallback 为 `auto`）：

```bash
opencode models codebuddy
```

| Provider | 目录来源 | Agent |
|---|---|---|
| `codebuddy` / `codebuddy-intl` | `GET /v3/config` | `craft` |
| `workbuddy-intl` | `GET /v3/config` | `cli` |
| `workbuddy` | `GET /console/enterprises/{enterpriseId}/models` | `cli` |

- `workbuddy` 国内版特例：`/v3/config` 在真实 WorkBuddy 身份下不返回积分倍率，因此改走官方 console 接口（`{enterpriseId}` 缺省为 `personal`，可用 `WORKBUDDY_ENTERPRISE_ID` 指定企业版），并额外追加 `deepseek-v4-flash`。
- 显示名格式为 `名称 (倍率 · 上下文)`，例如 `Hy4 preview (x0.29 · 1M)`、`MiniMax-M3 (x0.25 · 512K)`；无倍率时只带上下文（如 `Auto (168K)`）。
- 上下限同时写入 opencode 的 `limit.context` / `limit.output`，用于上下文占用判断与自动压缩。

## 环境变量

普通用户无需任何配置（tenant / enterprise / user 与 X-Domain 均从 token 自动提取）。

```bash
# 强制指定模型（忽略 OpenCode 的模型选择）
export CODEBUDDY_DEFAULT_MODEL=deepseek-v4-pro
export WORKBUDDY_DEFAULT_MODEL=deepseek-v4-pro

# 覆盖企业 / 租户 / 用户信息（不设置则从 JWT 自动提取）
export CODEBUDDY_TENANT_ID=xxx
export CODEBUDDY_ENTERPRISE_ID=xxx
export CODEBUDDY_USER_ID=xxx
# ... WORKBUDDY_ 同名变量同理

# 覆盖 X-Domain（优先级最高）
export CODEBUDDY_DOMAIN=www.codebuddy.cn
export WORKBUDDY_DOMAIN=www.workbuddy.cn
```

| 变量 | 说明 |
|---|---|
| `${PREFIX}_DEFAULT_MODEL` | 强制使用指定模型 |
| `${PREFIX}_TENANT_ID` | 覆盖 tenant_id |
| `${PREFIX}_ENTERPRISE_ID` | 覆盖 enterprise_id（同时影响 `workbuddy` 的目录地址与企业版目录） |
| `${PREFIX}_USER_ID` | 覆盖 user_id |
| `${PREFIX}_DOMAIN` | 覆盖 X-Domain |

`PREFIX` 为 `CODEBUDDY` 或 `WORKBUDDY`。

## X-Domain 决策

优先级：`${PREFIX}_DOMAIN` > 登录 JWT 的 `iss` 主机名（`new URL(iss).hostname`）> provider 兜底。实现与真实客户端一致，**不**从 baseURL 推断。

## 工作原理

```
OpenCode
  ├─ config hook   → 读 ~/.local/share/opencode/auth.json（按 provider id 分槽）
  │                  拉取模型目录 → 注入 provider.<id>.models
  ├─ auth hook     → 浏览器 IOA OAuth（state → 轮询）→ access_token + refresh_token
  ├─ loader()      → 返回 { apiKey, baseURL, fetch }，拦截 /chat/completions
  └─ chat.params   → 固定该 provider 的 baseURL
```

**为什么需要多入口 / 特殊入口**：OpenCode 以 provider id 为 key 聚合所有插件实例的 auth hooks（`provider/auth.ts`），每个实例只能注册一个 `auth.provider`。本地文件插件按**文件 URL** 去重，故拆成 `src/provider/*.ts` 四个不同路径的入口，各自 default export `{ id, server }`，由共享工厂 `TencentAuthPlugin(input, { provider })` 承载全部逻辑。npm 插件按**包名**去重（`config/plugin.ts` 的 `deduplicatePluginOrigins`），四个子路径会被折叠成一个，因此 npm 入口 `src/server.ts` 改为**具名导出 4 个插件函数**、不提供 v1 默认对象，走 OpenCode 的 legacy 多实例加载。

**对话请求**：拦截后附加认证 headers（`Authorization`、`X-Domain`、`X-Tenant/Enterprise/User-Id`、`X-Agent-Intent`、`X-Model-ID`、B3 追踪等），转发到 `{server}/v2/chat/completions`，透传 OpenAI 兼容 SSE。X-Domain 每次由当前 access token 的 `iss` 实时计算。

**Token 刷新**（`POST /v2/plugin/auth/token/refresh`，与真实客户端一致）：`Authorization: Bearer <access>`、`X-Refresh-Token`、`X-User-Id`、`X-Auth-Refresh-Source: plugin`、`X-Product`、`X-Domain`、body `{}`。

**登录接口**：`POST {server}/v2/plugin/auth/state?platform=VSCode&ioa=1`（带 `X-No-*` 头）→ 轮询 `GET {server}/v2/plugin/auth/token?state=`。

## 常见问题

- **模型列表只有 `Auto`**：多为尚未登录或 token 失效。重新 `opencode providers login --provider <id>`；`config` hook 在拉取失败时会 fallback 为 `auto`。
- **登录后不弹浏览器**：手动复制终端打印的授权 URL 到浏览器完成即可，插件会继续轮询。
- **对话报 401/403**：插件会自动尝试刷新；若仍失败通常是 refresh token 也过期，重新登录。
- **看不到积分倍率**：服务端未下发 `credits`（例如 WorkBuddy 国际版部分套餐模型）时保持原名，属正常。
- **`workbuddy` 企业版模型不全**：设置 `WORKBUDDY_ENTERPRISE_ID`，插件会改用企业版目录。

## 开发

```bash
npm install
npm run build   # tsc → dist/
```

无测试、无 lint、无 CI。产物包含 `dist/index.js` 与 `dist/provider/*.js`（4 个入口）。开发约束见 [`AGENTS.md`](./AGENTS.md)。

## 免责声明

本项目仅用于个人学习与合法用途，与腾讯及其关联公司无任何隶属关系。接口均为客户端内部实现，可能随时变更；使用者需自行承担风险。

## 许可证

[MIT](./LICENSE)
