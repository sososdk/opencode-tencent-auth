import { TencentAuthPlugin } from "../index.js";
import type { PluginModule } from "@opencode-ai/plugin";

export default {
  id: "tencent-auth-workbuddy",
  server: (input) => TencentAuthPlugin(input, { provider: "workbuddy" }),
} satisfies PluginModule;
