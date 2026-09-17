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
  appVersion: string;
  ideName: string;
  ideType: string;
  ideVersion: string;
  userAgent: string;
  envPrefix: string;
  agentIntent: string;
  catalogUrl?: string;
  extraModels?: string[];
}

export const PROVIDERS: Readonly<Record<string, ProviderSpec>> = {
  codebuddy: {
    id: "codebuddy",
    name: "CodeBuddy",
    serverUrl: "https://copilot.tencent.com",
    chatCompletionsPath: "/v2/chat/completions",
    fallbackDomain: "www.codebuddy.cn",
    product: "SaaS",
    appVersion: "4.9.29177644",
    ideName: "VSCode",
    ideType: "VSCode",
    ideVersion: "1.119.0",
    userAgent: "CodeBuddy",
    envPrefix: "CODEBUDDY",
    agentIntent: "craft",
  },
  "codebuddy-intl": {
    id: "codebuddy-intl",
    name: "CodeBuddy (International)",
    serverUrl: "https://www.codebuddy.ai",
    chatCompletionsPath: "/v2/chat/completions",
    fallbackDomain: "www.codebuddy.ai",
    product: "SaaS",
    appVersion: "4.9.29177644",
    ideName: "VSCode",
    ideType: "VSCode",
    ideVersion: "1.119.0",
    userAgent: "CodeBuddy",
    envPrefix: "CODEBUDDY",
    agentIntent: "craft",
  },
  workbuddy: {
    id: "workbuddy",
    name: "WorkBuddy",
    serverUrl: "https://www.workbuddy.cn",
    chatCompletionsPath: "/v2/chat/completions",
    fallbackDomain: "www.workbuddy.cn",
    product: "SaaS",
    appVersion: "5.5.6",
    ideName: "VSCode",
    ideType: "VSCode",
    ideVersion: "1.119.0",
    userAgent: "WorkBuddy",
    envPrefix: "WORKBUDDY",
    agentIntent: "cli",
    catalogUrl: "https://www.workbuddy.cn/console/enterprises/{enterpriseId}/models",
    extraModels: ["deepseek-v4-flash"],
  },
  "workbuddy-intl": {
    id: "workbuddy-intl",
    name: "WorkBuddy (International)",
    serverUrl: "https://www.workbuddy.ai",
    chatCompletionsPath: "/v2/chat/completions",
    fallbackDomain: "www.workbuddy.ai",
    product: "SaaS",
    appVersion: "1.0.0",
    ideName: "VSCode",
    ideType: "VSCode",
    ideVersion: "1.119.0",
    userAgent: "WorkBuddy",
    envPrefix: "WORKBUDDY",
    agentIntent: "cli",
  },
};

interface Runtime {
  spec: ProviderSpec;
  platform: string;
  agentIntent: string;
  envId: string;
  tenantId: string;
  enterpriseId: string;
  userId: string;
  defaultModel: string;
  domainOverride: string;
}

interface JwtPayload {
  iss?: string;
  tenant_id?: string;
  tenantId?: string;
  enterprise_id?: string;
  enterpriseId?: string;
  ent_id?: string;
  entId?: string;
  user_id?: string;
  userId?: string;
  uid?: string;
  sub?: string;
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
}

interface RemoteConfigResponse {
  code: number;
  data?: {
    agents?: Array<{ name: string; models?: string[] }>;
    models?: RemoteModel[];
  };
}

const DEFAULT_MODEL: RemoteModel = {
  id: "auto",
  name: "Auto",
  maxInputTokens: 168000,
  maxOutputTokens: 32000,
  supportsToolCall: true,
  supportsImages: true,
};

const DISCOVERY_TIMEOUT_MS = 5000;

function createRuntime(spec: ProviderSpec): Runtime {
  const prefix = spec.envPrefix;
  return {
    spec,
    platform: "VSCode",
    agentIntent: spec.agentIntent,
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
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: `Bearer ${accessToken}`,
    "X-Agent-Intent": ctx.agentIntent,
    "X-IDE-Type": spec.ideType,
    "X-IDE-Name": spec.ideName,
    "X-IDE-Version": spec.ideVersion,
    "X-Product-Version": spec.appVersion,
    "X-Env-ID": ctx.envId,
    "X-Domain": resolveDomain(accessToken, ctx),
    "X-Product": spec.product,
    "User-Agent": `${spec.ideName}/${spec.ideVersion} ${spec.userAgent}/${spec.appVersion}`,
  };
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
  const p = decodeJwtPayload(accessToken);
  if (!p) return "";
  const iss = p.iss || "";
  const m = iss.match(/realms\/sso-([^/]+)$/);
  return p.tenant_id || p.tenantId || (m?.[1] || "");
}

function resolveEnterpriseId(accessToken: string, ctx: Runtime): string {
  if (ctx.enterpriseId) return ctx.enterpriseId;
  const p = decodeJwtPayload(accessToken);
  if (!p) return "";
  const roles = p.realm_access?.roles || p.resource_access?.account?.roles;
  if (roles) {
    for (const r of roles) {
      const m = r.match(/group-admin:([A-Za-z0-9-]+)/);
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
  const params = new URLSearchParams({ platform: ctx.platform, ioa: "1" });
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
    `${ctx.spec.serverUrl}/login?platform=${ctx.platform}&state=${data.data.state}&ioa=1`;
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
      }
    } catch {
      if (signal?.aborted) return null;
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

async function fetchRemoteModels(
  accessToken: string,
  ctx: Runtime,
): Promise<RemoteModel[]> {
  const spec = ctx.spec;
  const headers = buildStaticHeaders(accessToken, ctx);
  applyIdentityHeaders(headers, accessToken, ctx);
  const catalogUrl = (spec.catalogUrl || `${spec.serverUrl}/v3/config`).replace(
    "{enterpriseId}",
    resolveEnterpriseId(accessToken, ctx) || "personal",
  );
  const resp = await fetch(catalogUrl, { headers });
  if (!resp.ok) return [];
  const body = (await resp.json()) as RemoteConfigResponse;
  if (body.code !== 0 || !body.data) return [];
  const allModels = body.data.models || [];
  const modelMap = new Map(allModels.map((m) => [m.id, m]));
  const agent = (body.data.agents || []).find((a) => a.name === ctx.agentIntent);
  const agentIds = agent?.models || [];
  if (agentIds.length === 0) return [DEFAULT_MODEL];
  const ids = [...new Set([...agentIds, ...(spec.extraModels || [])])];
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
          discovered = await Promise.race([
            fetchRemoteModels(auth.access, ctx),
            new Promise<RemoteModel[]>((resolve) =>
              setTimeout(() => resolve([]), DISCOVERY_TIMEOUT_MS),
            ),
          ]);
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
      output.options.baseURL = `${spec.serverUrl}/v2`;
    },
  } satisfies Hooks;
}

export default {
  id: "tencent-auth",
  server: TencentAuthPlugin,
};