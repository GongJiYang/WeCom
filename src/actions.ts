import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ClawdbotConfig,
} from "clawdbot/plugin-sdk";
import { jsonResult, readStringParam } from "clawdbot/plugin-sdk";

import { listEnabledWeComAccounts } from "./accounts.js";
import { sendMediaWeCom, sendMessageWeCom } from "./send.js";

const providerId = "wecom";

function listEnabledAccounts(cfg: ClawdbotConfig) {
  return listEnabledWeComAccounts(cfg).filter(
    (account) => account.enabled && account.configured,
  );
}

export const wecomMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledAccounts(cfg as ClawdbotConfig);
    if (accounts.length === 0) return [];
    const actions = new Set<ChannelMessageActionName>(["send"]);
    return Array.from(actions);
  },
  supportsButtons: () => false,
  extractToolSend: ({ args }) => {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action !== "sendMessage") return null;
    const to = typeof args.to === "string" ? args.to : undefined;
    if (!to) return null;
    const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
    return { to, accountId };
  },
  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action === "send") {
      const to = readStringParam(params, "to", { required: true });
      const content = readStringParam(params, "message", {
        required: true,
        allowEmpty: true,
      });
      const mediaUrl = readStringParam(params, "media", { trim: false });

      const result = mediaUrl
        ? await sendMediaWeCom(to ?? "", mediaUrl, {
            accountId: accountId ?? undefined,
            cfg: cfg as ClawdbotConfig,
            caption: content || undefined,
          })
        : await sendMessageWeCom(to ?? "", content ?? "", {
            accountId: accountId ?? undefined,
            cfg: cfg as ClawdbotConfig,
          });

      if (!result.ok) {
        return jsonResult({
          ok: false,
          error: result.error ?? "Failed to send WeCom message",
        });
      }

      return jsonResult({ ok: true, to, messageId: result.messageId });
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
