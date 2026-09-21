import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface ProviderSpec {
  id: string;
  name: string;
  serverUrl: string;
  chatCompletionsPath: string;
  fallbackDomain: string;
  product: string;
  /**
   * 客户端版本（WorkBuddy 取 product.json 的 genieVersion，CodeBuddy 取构建版本）。
   * 同时用于 X-IDE-Version / X-Product-Version / User-Agent。
   * 真实客户端在这些字段缺失时**不发** X-Product-Version，故本字段可留空。
   */
  clientVersion: string;
  /** X-IDE-Type / X-IDE-Name：WorkBuddy 桌面为 "WorkBuddy"，CodeBuddy IDE 为 "CodeBuddyIDE"。 */
  ideName: string;
  ideType: string;
  /**
   * 完整 User-Agent。注意：CodeBuddy 服务端**要求** UA 含 `VSCode/`，
   * 纯 `CodeBuddy/<ver>` 会返回空模型列表；WorkBuddy 服务端接受 `WorkBuddy/<ver>`。
   */
  userAgent: string;
  envPrefix: string;
  /** 从 /v3/config 取模型目录时使用的 agent 名（WorkBuddy = cli，CodeBuddy = craft）。 */
  modelAgentName: string;
  /** X-Agent-Intent 头：真实 CLI 恒为 "craft"（或 meta["codebuddy.ai/mode"]）。 */
  headerAgentIntent: string;
  /** /v2/plugin/auth/state 的 platform 查询参数（product.authentication.attributes.platform）。 */
  authPlatform: string;
  catalogUrl?: string;
}

export const PROVIDERS: Readonly<Record<string, ProviderSpec>> = {
  codebuddy: {
    id: "codebuddy",
    name: "CodeBuddy",
    serverUrl: "https://copilot.tencent.com",
    chatCompletionsPath: "/v2/chat/completions",
    fallbackDomain: "www.codebuddy.cn",
    product: "SaaS",
    clientVersion: "4.9.29177644",
    ideName: "CodeBuddyIDE",
    ideType: "CodeBuddyIDE",
    userAgent: "VSCode/1.119.0 CodeBuddy/4.9.29177644",
    envPrefix: "CODEBUDDY",
    modelAgentName: "craft",
    headerAgentIntent: "craft",
    authPlatform: "ide",
  },
  "codebuddy-intl": {
    id: "codebuddy-intl",
    name: "CodeBuddy (International)",
    serverUrl: "https://www.codebuddy.ai",
    chatCompletionsPath: "/v2/chat/completions",
    fallbackDomain: "www.codebuddy.ai",
    product: "SaaS",
    clientVersion: "4.9.29177644",
    ideName: "CodeBuddyIDE",
    ideType: "CodeBuddyIDE",
    userAgent: "VSCode/1.119.0 CodeBuddy/4.9.29177644",
    envPrefix: "CODEBUDDY",
    modelAgentName: "craft",
    headerAgentIntent: "craft",
    authPlatform: "ide",
  },
  workbuddy: {
    id: "workbuddy",
    name: "WorkBuddy",
    serverUrl: "https://www.workbuddy.cn",
    chatCompletionsPath: "/v2/chat/completions",
    fallbackDomain: "www.workbuddy.cn",
    product: "SaaS",
    clientVersion: "5.5.6",
    ideName: "WorkBuddy",
    ideType: "WorkBuddy",
    userAgent: "WorkBuddy/5.5.6",
    envPrefix: "WORKBUDDY",
    modelAgentName: "cli",
    headerAgentIntent: "craft",
    authPlatform: "workbuddy",
    catalogUrl: "https://www.workbuddy.cn/console/enterprises/{enterpriseId}/models",
  },
  "workbuddy-intl": {
    id: "workbuddy-intl",
    name: "WorkBuddy (International)",
    serverUrl: "https://www.workbuddy.ai",
    chatCompletionsPath: "/v2/chat/completions",
    fallbackDomain: "www.workbuddy.ai",
    product: "SaaS",
    clientVersion: "5.5.2",
    ideName: "WorkBuddy",
    ideType: "WorkBuddy",
    userAgent: "WorkBuddy/5.5.2",
    envPrefix: "WORKBUDDY",
    modelAgentName: "cli",
    headerAgentIntent: "craft",
    authPlatform: "workbuddy-ai",
  },
};

interface Runtime {
  spec: ProviderSpec;
  envId: string;
  tenantId: string;
  enterpriseId: string;
  userId: string;
  defaultModel: string;
  domainOverride: string;
}

interface JwtPayload {
  iss?: string;
  enterprise_id?: string;
  enterpriseId?: string;
  ent_id?: string;
  entId?: string;
  user_id?: string;
  userId?: string;
  uid?: string;
  sub?: string;
  nickname?: string;
  preferred_username?: string;
  name?: string;
  email?: string;
  realm_access?: { roles?: string[] };
  resource_access?: { account?: { roles?: string[] } };
}

interface AuthStateResponse {
  code: number;
  data?: {
    state: string;
    authUrl?: string;
  };
}

interface TokenPollResponse {
  code: number;
  data?: {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  };
}

interface RefreshResponse {
  code: number;
  data?: {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  };
}

interface OpenAIRequest {
  model?: string;
  stream?: boolean;
  response_format?: unknown;
  [key: string]: unknown;
}

interface RemoteModel {
  id: string;
  name: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  supportsToolCall?: boolean;
  supportsImages?: boolean;
  credits?: string;
  tags?: string[];
}

interface RemoteConfigResponse {
  code: number;
  data?: {
    agents?: Array<{ name: string; models?: string[] }>;
    models?: RemoteModel[];
    productFeatures?: { EnableAutoModelTiers?: boolean };
  };
}

interface EnterpriseUsageResponse {
  code: number;
  data?: {
    credit?: number;
    limitNum?: number;
  };
}

interface ResourceSummaryResponse {
  code: number;
  data?: {
    Packages?: Array<{
      CycleTotalCapacity?: string | number;
      CycleRemainCapacity?: string | number;
    }>;
  };
}

interface CreditBalance {
  remaining: number;
  total: number;
  unlimited: boolean;
}

const TIER_MODEL_IDS = ["fast-model", "balanced-model", "deep-model"];

const AUTO_TIER_MODELS: RemoteModel[] = [
  {
    id: "fast-model",
    name: "快速",
    credits: "x0.21",
    maxInputTokens: 300000,
    maxOutputTokens: 48000,
    supportsToolCall: true,
    supportsImages: true,
  },
  {
    id: "balanced-model",
    name: "均衡",
    credits: "x0.65",
    maxInputTokens: 300000,
    maxOutputTokens: 48000,
    supportsToolCall: true,
    supportsImages: true,
  },
  {
    id: "deep-model",
    name: "极致",
    credits: "x1.20",
    maxInputTokens: 300000,
    maxOutputTokens: 48000,
    supportsToolCall: true,
    supportsImages: true,
  },
];

// 未发现任何模型时的兜底项。刻意不写 maxInputTokens/maxOutputTokens：
// 上下文/输出长度必须来自服务端，硬编码会导致 opencode 用错误阈值做自动压缩。
const DEFAULT_MODEL: RemoteModel = {
  id: "auto",
  name: "Auto",
  supportsToolCall: true,
  supportsImages: true,
};

const DISCOVERY_TIMEOUT_MS = 5000;

function createRuntime(spec: ProviderSpec): Runtime {
  const prefix = spec.envPrefix;
  return {
    spec,
    envId: "production",
    tenantId: process.env[`${prefix}_TENANT_ID`] || "",
    enterpriseId: process.env[`${prefix}_ENTERPRISE_ID`] || "",
    userId: process.env[`${prefix}_USER_ID`] || "",
    defaultModel: process.env[`${prefix}_DEFAULT_MODEL`] || "",
    domainOverride: process.env[`${prefix}_DOMAIN`] || "",
  };
}

function formatContext(tokens: number | undefined): string {
  if (!tokens || tokens <= 0) return "";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return `${Number.isInteger(k) ? k : Math.round(k)}K`;
  }
  return String(tokens);
}

function formatCredits(b: CreditBalance): string {
  if (b.unlimited) return "积分不限";
  const fmt = (n: number) =>
    Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
  return `积分 ${fmt(b.remaining)}/${fmt(b.total)}`;
}

function remoteModelToConfig(m: RemoteModel): Record<string, unknown> {
  const rate = (m.credits || "").trim().replace(/\s+credits$/i, "");
  const context = formatContext(m.maxInputTokens);
  const tags = [rate, context].filter(Boolean);
  const entry: Record<string, unknown> = {
    name: tags.length ? `${m.name} (${tags.join(" · ")})` : m.name,
  };
  if (m.maxInputTokens || m.maxOutputTokens) {
    entry.limit = { context: m.maxInputTokens ?? 0, output: m.maxOutputTokens ?? 0 };
  }
  if (m.supportsToolCall) entry.tool_call = true;
  if (m.supportsImages) {
    entry.attachment = true;
    entry.modalities = { input: ["text", "image"], output: ["text"] };
  }
  return entry;
}

function buildStaticHeaders(
  accessToken: string,
  ctx: Runtime,
): Record<string, string> {
  const spec = ctx.spec;
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: `Bearer ${accessToken}`,
    "X-Agent-Intent": spec.headerAgentIntent,
    "X-IDE-Type": spec.ideType,
    "X-IDE-Name": spec.ideName,
    "X-Env-ID": ctx.envId,
    "X-Domain": resolveDomain(accessToken, ctx),
    "X-Product": spec.product,
    "User-Agent": spec.userAgent,
  };
  // 真实客户端仅在 productVersion 存在时发这两个头；本字段可留空。
  if (spec.clientVersion) {
    headers["X-IDE-Version"] = spec.clientVersion;
    headers["X-Product-Version"] = spec.clientVersion;
  }
  return headers;
}

function applyIdentityHeaders(
  headers: Record<string, string>,
  accessToken: string,
  ctx: Runtime,
): void {
  const tenantId = resolveTenantId(accessToken, ctx);
  const enterpriseId = resolveEnterpriseId(accessToken, ctx);
  const userId = resolveUserId(accessToken, ctx);
  if (tenantId) headers["X-Tenant-Id"] = tenantId;
  if (enterpriseId) headers["X-Enterprise-Id"] = enterpriseId;
  if (userId) headers["X-User-Id"] = userId;
}

function buildAuthHeaders(
  accessToken: string,
  modelId: string | undefined,
  ctx: Runtime,
): Record<string, string> {
  const conversationId = generateTraceId();
  const messageId = generateTraceId();
  const traceId = generateTraceId();
  const spanId = generateTraceId().slice(0, 16);
  const parentSpanId = generateTraceId().slice(0, 16);

  const headers: Record<string, string> = {
    ...buildStaticHeaders(accessToken, ctx),
    "X-Request-ID": messageId,
    "X-Conversation-ID": conversationId,
    "X-Conversation-Request-ID": messageId,
    "X-Conversation-Message-ID": messageId,
    "X-Request-Trace-Id": traceId,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    "X-B3-TraceId": traceId,
    "X-B3-ParentSpanId": parentSpanId,
    "X-B3-SpanId": spanId,
    "X-B3-Sampled": "1",
  };

  applyIdentityHeaders(headers, accessToken, ctx);
  if (modelId) headers["X-Model-ID"] = modelId;

  return headers;
}

function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(payload + pad, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function jwtIssHostname(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  if (!payload?.iss) return undefined;
  try {
    const hostname = new URL(payload.iss).hostname;
    return hostname || undefined;
  } catch {
    return undefined;
  }
}

function resolveDomain(accessToken: string, ctx: Runtime): string {
  if (ctx.domainOverride) return ctx.domainOverride;
  const hostname = jwtIssHostname(accessToken);
  if (hostname) return hostname;
  return ctx.spec.fallbackDomain;
}

function resolveTenantId(accessToken: string, ctx: Runtime): string {
  if (ctx.tenantId) return ctx.tenantId;
  // 客户端将 X-Tenant-Id 与 X-Enterprise-Id 设为同一个值（account.enterpriseId），
  // 均来自企业角色；不存在独立的 sso-<tenant> 来源。
  return resolveEnterpriseId(accessToken, ctx);
}

function resolveEnterpriseId(accessToken: string, ctx: Runtime): string {
  if (ctx.enterpriseId) return ctx.enterpriseId;
  const p = decodeJwtPayload(accessToken);
  if (!p) return "";
  const roles = p.realm_access?.roles || p.resource_access?.account?.roles;
  if (roles) {
    for (const r of roles) {
      const m = r.match(/^(?:ent-member|ent-admin|ent-plugin-enabled|group-admin):([A-Za-z0-9-]+)$/);
      if (m?.[1]) return m[1];
    }
  }
  return p.enterprise_id || p.enterpriseId || p.ent_id || p.entId || "";
}

function resolveUserId(accessToken: string, ctx: Runtime): string {
  if (ctx.userId) return ctx.userId;
  const p = decodeJwtPayload(accessToken);
  return p?.user_id || p?.userId || p?.uid || p?.sub || "";
}

function resolveAccountName(accessToken: string): string {
  const p = decodeJwtPayload(accessToken);
  if (!p) return "";
  return p.nickname || p.preferred_username || p.name || p.email || "";
}

function resolveModel(inputModel: string | undefined, ctx: Runtime): string {
  if (ctx.defaultModel) return ctx.defaultModel;
  return inputModel || "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LOGIN_NO_AUTH_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/json",
  "X-No-Authorization": "true",
  "X-No-User-Id": "true",
  "X-No-Enterprise-Id": "true",
  "X-No-Department-Info": "true",
};

async function requestAuthState(ctx: Runtime): Promise<{ state: string; url: string }> {
  const params = new URLSearchParams({ platform: ctx.spec.authPlatform, ioa: "1" });
  const response = await fetch(
    `${ctx.spec.serverUrl}/v2/plugin/auth/state?${params.toString()}`,
    {
      method: "POST",
      headers: {
        ...LOGIN_NO_AUTH_HEADERS,
        "Content-Type": "application/json",
      },
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Auth state request failed: ${response.status} - ${text}`);
  }
  const data = (await response.json()) as AuthStateResponse;
  if (data.code !== 0 || !data.data?.state) {
    throw new Error(`Invalid auth state response: ${JSON.stringify(data)}`);
  }
  const loginUrl =
    data.data.authUrl ||
    `${ctx.spec.serverUrl}/login?platform=${ctx.spec.authPlatform}&state=${data.data.state}&ioa=1`;
  return { state: data.data.state, url: loginUrl };
}

async function pollForToken(
  state: string,
  expiresAt: number,
  ctx: Runtime,
  signal?: AbortSignal,
): Promise<TokenPollResponse["data"] | null> {
  while (Date.now() < expiresAt) {
    if (signal?.aborted) return null;
    await sleep(3000);
    try {
      const response = await fetch(
        `${ctx.spec.serverUrl}/v2/plugin/auth/token?state=${state}`,
        {
          method: "GET",
          headers: LOGIN_NO_AUTH_HEADERS,
          signal,
        },
      );
      if (response.ok) {
        const data = (await response.json()) as TokenPollResponse;
        if (data.code === 0 && data.data?.accessToken) return data.data;
        if (data.code !== 0) {
          console.warn(
            `[auth] token poll returned code ${data.code}: ${JSON.stringify(data)}`,
          );
        }
      } else {
        const text = await response.text().catch(() => "");
        console.warn(
          `[auth] token poll failed: HTTP ${response.status} - ${text.slice(0, 200)}`,
        );
      }
    } catch (error) {
      if (signal?.aborted) return null;
      console.warn(`[auth] token poll error: ${String(error)}`);
    }
  }
  return null;
}

async function refreshAccessToken(
  accessToken: string,
  refreshToken: string,
  ctx: Runtime,
): Promise<RefreshResponse["data"] | null> {
  try {
    const userId = resolveUserId(accessToken, ctx);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "X-Refresh-Token": refreshToken,
      "X-Auth-Refresh-Source": "plugin",
      "X-Product": ctx.spec.product,
    };
    if (userId) headers["X-User-Id"] = userId;
    const response = await fetch(
      `${ctx.spec.serverUrl}/v2/plugin/auth/token/refresh`,
      {
        method: "POST",
        headers,
        body: "{}",
      },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as RefreshResponse;
    if (data.code !== 0) return null;
    return data.data || null;
  } catch {
    return null;
  }
}

async function fetchConfig(
  accessToken: string,
  ctx: Runtime,
): Promise<RemoteConfigResponse["data"] | null> {
  const headers = buildStaticHeaders(accessToken, ctx);
  applyIdentityHeaders(headers, accessToken, ctx);
  try {
    const resp = await fetch(`${ctx.spec.serverUrl}/v3/config`, { headers });
    if (!resp.ok) return null;
    const body = (await resp.json()) as RemoteConfigResponse;
    if (body.code !== 0 || !body.data) return null;
    return body.data;
  } catch {
    return null;
  }
}

async function fetchCatalog(
  accessToken: string,
  ctx: Runtime,
): Promise<RemoteConfigResponse["data"] | null> {
  const spec = ctx.spec;
  if (!spec.catalogUrl) return null;
  const headers = buildStaticHeaders(accessToken, ctx);
  applyIdentityHeaders(headers, accessToken, ctx);
  const catalogUrl = spec.catalogUrl.replace(
    "{enterpriseId}",
    resolveEnterpriseId(accessToken, ctx) || "personal",
  );
  try {
    const resp = await fetch(catalogUrl, { headers });
    if (!resp.ok) return null;
    const body = (await resp.json()) as RemoteConfigResponse;
    if (body.code !== 0 || !body.data) return null;
    return body.data;
  } catch {
    return null;
  }
}

async function fetchCredits(
  accessToken: string,
  ctx: Runtime,
): Promise<CreditBalance | null> {
  const headers = buildStaticHeaders(accessToken, ctx);
  applyIdentityHeaders(headers, accessToken, ctx);
  const enterpriseId = resolveEnterpriseId(accessToken, ctx);

  try {
    if (enterpriseId) {
      const resp = await fetch(
        `${ctx.spec.serverUrl}/v2/billing/meter/get-enterprise-user-usage`,
        { method: "POST", headers, body: "{}" },
      );
      if (!resp.ok) return null;
      const body = (await resp.json()) as EnterpriseUsageResponse;
      if (body.code !== 0 || !body.data) return null;
      const total = body.data.limitNum ?? 0;
      const remaining = body.data.credit ?? 0;
      return { remaining, total, unlimited: total === -1 };
    }

    const resp = await fetch(
      `${ctx.spec.serverUrl}/billing/meter/get-user-resource-summary`,
      { method: "POST", headers, body: "{}" },
    );
    if (!resp.ok) return null;
    const body = (await resp.json()) as ResourceSummaryResponse;
    if (body.code !== 0 || !body.data) return null;
    let total = 0;
    let remaining = 0;
    for (const p of body.data.Packages || []) {
      total += Number(p.CycleTotalCapacity) || 0;
      remaining += Number(p.CycleRemainCapacity) || 0;
    }
    return { remaining, total, unlimited: false };
  } catch {
    return null;
  }
}

async function fetchRemoteModels(
  accessToken: string,
  ctx: Runtime,
): Promise<RemoteModel[]> {
  const spec = ctx.spec;
  const [config, catalog] = await Promise.all([
    fetchConfig(accessToken, ctx),
    fetchCatalog(accessToken, ctx),
  ]);

  const preferCatalog = !!(spec.catalogUrl && catalog);
  const primary = preferCatalog ? catalog : config;
  if (!primary) return [];
  const secondary = preferCatalog ? config : catalog;

  const modelMap = new Map<string, RemoteModel>();
  for (const m of secondary?.models || []) modelMap.set(m.id, m);
  for (const m of primary.models || []) modelMap.set(m.id, m);

  const agent =
    (primary.agents || []).find((a) => a.name === spec.modelAgentName) ||
    (secondary?.agents || []).find((a) => a.name === spec.modelAgentName);
  const agentIds = agent?.models || [];
  if (agentIds.length === 0) return [DEFAULT_MODEL];

  const usesTiers = !!spec.catalogUrl && config?.productFeatures?.EnableAutoModelTiers !== false;

  if (usesTiers) {
    for (const m of AUTO_TIER_MODELS) {
      if (!modelMap.has(m.id)) modelMap.set(m.id, m);
    }
  }

  let orderedIds: string[];
  if (usesTiers) {
    const rest = agentIds.filter((id) => id !== "auto" && !TIER_MODEL_IDS.includes(id));
    orderedIds = [...TIER_MODEL_IDS, ...rest];
  } else {
    orderedIds = [...agentIds];
  }

  const ids = [...new Set(orderedIds)];
  return ids
    .map((id) => modelMap.get(id))
    .filter((m): m is RemoteModel => !!m?.supportsToolCall);
}

export async function TencentAuthPlugin(
  input: PluginInput,
  options?: PluginOptions,
): Promise<Hooks> {
  const providerId =
    typeof options?.provider === "string" ? options.provider : "codebuddy";
  const spec = PROVIDERS[providerId];
  if (!spec) throw new Error(`Unknown provider "${providerId}"`);

  const ctx = createRuntime(spec);

  return {
    async config(config) {
      if (!config.provider) config.provider = {};
      if (!config.provider[spec.id]) {
        config.provider[spec.id] = {
          npm: "@ai-sdk/openai-compatible",
          name: spec.name,
          options: {
            baseURL: `${spec.serverUrl}/v2`,
            setCacheKey: true,
          },
          models: {},
        };
      }
      const provider = config.provider[spec.id] as
        | Record<string, unknown>
        | undefined;
      if (!provider) return;
      if (!provider.models) {
        provider.models = {};
      }
      const models = provider.models as Record<string, unknown>;

      let discovered: RemoteModel[] = [];
      try {
        const home = os.homedir();
        const authPath = path.join(home, ".local", "share", "opencode", "auth.json");
        const raw = fs.readFileSync(authPath, "utf8");
        const all = JSON.parse(raw) as Record<string, { type: string; access?: string }>;
        const auth = all[spec.id];
        if (auth?.type === "oauth" && auth.access) {
          const access = auth.access;
          const [modelsResult, creditsResult] = await Promise.all([
            Promise.race([
              fetchRemoteModels(access, ctx),
              new Promise<RemoteModel[]>((resolve) =>
                setTimeout(() => resolve([]), DISCOVERY_TIMEOUT_MS),
              ),
            ]),
            Promise.race([
              fetchCredits(access, ctx),
              new Promise<CreditBalance | null>((resolve) =>
                setTimeout(() => resolve(null), DISCOVERY_TIMEOUT_MS),
              ),
            ]),
          ]);
          discovered = modelsResult;
          const accountName = resolveAccountName(access);
          const nameParts = [spec.name];
          if (accountName) nameParts.push(accountName);
          if (creditsResult) nameParts.push(formatCredits(creditsResult));
          provider.name = nameParts.join(" · ");
        }
      } catch {
        // auth not available yet, use fallback
      }

      if (discovered.length === 0) {
        discovered = [DEFAULT_MODEL];
      }

      for (const m of discovered) {
        if (models[m.id]) continue;
        models[m.id] = remoteModelToConfig(m);
      }
    },
    auth: {
      provider: spec.id,
      async loader(getAuth, _provider) {
        return {
          apiKey: "cli-proxy",
          baseURL: `${spec.serverUrl}/v2`,
          async fetch(
            url: RequestInfo | URL,
            init?: RequestInit,
          ): Promise<Response> {
            const urlStr = url.toString();
            if (!urlStr.includes("/chat/completions")) {
              return fetch(url, init);
            }

            const currentAuth = await getAuth();
            if (currentAuth.type !== "oauth" || !currentAuth.access) {
              throw new Error(`[${spec.id}] 缺少 access token，请重新登录`);
            }

            let accessToken = currentAuth.access;
            const body = init?.body;
            if (!body) {
              return new Response(
                JSON.stringify({ error: "Missing request body" }),
                {
                  status: 400,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }

            const openaiRequest = JSON.parse(
              typeof body === "string"
                ? body
                : await new Response(body).text(),
            ) as OpenAIRequest;

            const resolvedModel = resolveModel(openaiRequest.model, ctx);
            if (!resolvedModel) {
              throw new Error(
                `[${spec.id}] 未设置模型，请设置 ${spec.envPrefix}_DEFAULT_MODEL 或在 OpenCode 选择模型`,
              );
            }

            const requestBody: OpenAIRequest = {
              ...openaiRequest,
              model: resolvedModel,
              stream: openaiRequest.stream ?? true,
            };

            const doRequest = async (token: string) => {
              return fetch(
                `${spec.serverUrl}${spec.chatCompletionsPath}`,
                {
                  method: "POST",
                  headers: buildAuthHeaders(token, resolvedModel, ctx),
                  body: JSON.stringify(requestBody),
                },
              );
            };

            let response = await doRequest(accessToken);

            if (
              (response.status === 401 || response.status === 403) &&
              currentAuth.refresh
            ) {
              console.log(`[${spec.id}] Token expired, attempting refresh...`);
              const refreshed = await refreshAccessToken(accessToken, currentAuth.refresh, ctx);
              if (refreshed?.accessToken) {
                accessToken = refreshed.accessToken;
                const newExpires = refreshed.expiresIn
                  ? Date.now() + refreshed.expiresIn * 1000
                  : Date.now() + 24 * 60 * 60 * 1000;
                await input.client.auth.set({
                  path: { id: spec.id },
                  body: {
                    type: "oauth",
                    access: refreshed.accessToken,
                    refresh: refreshed.refreshToken || currentAuth.refresh,
                    expires: newExpires,
                  },
                });
                console.log(
                  `[${spec.id}] refreshed token via ${spec.serverUrl} (X-Domain=${resolveDomain(accessToken, ctx)})`,
                );
                response = await doRequest(accessToken);
              }
            }

            if (!response.ok) {
              const errorText = await response.text();
              console.error(
                `[${spec.id}] API error: ${response.status} - ${errorText}`,
              );
              return new Response(errorText, {
                status: response.status,
                headers: { "Content-Type": "application/json" },
              });
            }

            return response;
          },
        };
      },
      methods: [
        {
          label: "IOA 登录 (浏览器)",
          type: "oauth",
          async authorize() {
            const authState = await requestAuthState(ctx);
            const expiresAt = Date.now() + 10 * 60 * 1000;
            return {
              url: authState.url,
              instructions: "请在浏览器中完成 IOA 登录",
              method: "auto" as const,
              async callback() {
                const tokenData = await pollForToken(
                  authState.state,
                  expiresAt,
                  ctx,
                );
                if (!tokenData) return { type: "failed" as const };
                console.log(
                  `[${spec.id}] login success (X-Domain=${resolveDomain(tokenData.accessToken, ctx)})`,
                );
                return {
                  type: "success" as const,
                  access: tokenData.accessToken,
                  refresh: tokenData.refreshToken || "",
                  expires: tokenData.expiresIn
                    ? Date.now() + tokenData.expiresIn * 1000
                    : Date.now() + 24 * 60 * 60 * 1000,
                };
              },
            };
          },
        },
      ],
    },
    async "chat.params"(input, output) {
      if (input.model.providerID !== spec.id) return;
      // 与 loader() 返回的 baseURL 同值：loader 设定 provider 级 base，chat.params
      // 的 options 会覆盖单次调用，两者都指向 {serverUrl}/v2，属防御性冗余。
      output.options.baseURL = `${spec.serverUrl}/v2`;
    },
  } satisfies Hooks;
}

export default {
  id: "tencent-auth",
  server: TencentAuthPlugin,
};