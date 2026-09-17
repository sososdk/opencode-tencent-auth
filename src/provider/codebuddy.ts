import { TencentAuthPlugin } from "../index.js";
import type { PluginModule } from "@opencode-ai/plugin";

export default {
  id: "tencent-auth-codebuddy",
  server: (input) => TencentAuthPlugin(input, { provider: "codebuddy" }),
} satisfies PluginModule;
