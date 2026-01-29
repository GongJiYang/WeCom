import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { wecomPlugin } from "./src/channel.js";
import { handleWeComWebhookRequest } from "./src/monitor.js";
import { handleWeComOpenApiCallback } from "./src/openapi-callback.js";
import { setWeComRuntime } from "./src/runtime.js";

const plugin = {
  id: "wecom",
  name: "WeCom",
  description: "企业微信 channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: ClawdbotPluginApi) {
    setWeComRuntime(api.runtime);
    api.registerChannel({ plugin: wecomPlugin });
    // 用 route 注册 webhook 路径，确保请求被正确路由到 wecom handler（plugin 的 httpHandlers 可能未被调用）
    api.registerHttpRoute({
      path: "/webhook/wecom/default",
      handler: async (req, res) => {
        await handleWeComWebhookRequest(req, res);
      },
    });
    api.registerHttpHandler(handleWeComWebhookRequest);
    // 专门给「API 接收消息」用的 OpenAPI 回调检测地址
    api.registerHttpRoute({ path: "/wecom/openapi-callback", handler: handleWeComOpenApiCallback });
  },
};

export default plugin;
