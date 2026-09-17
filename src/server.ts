import type { Plugin } from "@opencode-ai/plugin";
import { TencentAuthPlugin } from "./index.js";

/**
 * npm entry (`opencode-tencent-auth`).
 *
 * OpenCode dedupes npm plugin specs by package name, so a single npm package
 * cannot register four providers through four subpath specifiers. Instead this
 * module is intentionally a "legacy" plugin module: it has no v1 `{ id, server }`
 * default export, only named plugin functions. OpenCode's loader treats every
 * function export as an independent plugin instance, so all four providers are
 * registered from one `"opencode-tencent-auth"` entry.
 *
 * Keep this module free of non-function exports: the loader throws on any export
 * that is not a plugin function.
 */
export const CodeBuddy: Plugin = (input) =>
  TencentAuthPlugin(input, { provider: "codebuddy" });

export const CodeBuddyIntl: Plugin = (input) =>
  TencentAuthPlugin(input, { provider: "codebuddy-intl" });

export const WorkBuddy: Plugin = (input) =>
  TencentAuthPlugin(input, { provider: "workbuddy" });

export const WorkBuddyIntl: Plugin = (input) =>
  TencentAuthPlugin(input, { provider: "workbuddy-intl" });
