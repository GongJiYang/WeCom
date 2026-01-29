import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  ClawdbotConfig,
  WizardPrompter,
} from "clawdbot/plugin-sdk";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  promptAccountId,
} from "clawdbot/plugin-sdk";

import {
  listWeComAccountIds,
  resolveDefaultWeComAccountId,
  resolveWeComAccount,
} from "./accounts.js";
import { probeWeCom } from "./probe.js";
import type { WeComConfig } from "./types.js";

const channel = "wecom" as const;

function setWeComDmPolicy(
  cfg: ClawdbotConfig,
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled",
): ClawdbotConfig {
  const wecomConfig = (cfg.channels?.wecom as WeComConfig | undefined) ?? {};
  const allowFrom = dmPolicy === "open" ? addWildcardAllowFrom(wecomConfig.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      wecom: {
        ...wecomConfig,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  } as ClawdbotConfig;
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "WeCom",
  channel,
  policyKey: "channels.wecom.dmPolicy",
  allowFromKey: "channels.wecom.allowFrom",
  getCurrent: (cfg) => {
    const wecomConfig = (cfg.channels?.wecom as WeComConfig | undefined) ?? {};
    const raw = wecomConfig.dmPolicy;
    return raw === "allowlist" || raw === "open" || raw === "disabled" ? raw : "pairing";
  },
  setPolicy: (cfg, policy) => setWeComDmPolicy(cfg as ClawdbotConfig, policy),
  promptAllowFrom: async ({ cfg, prompter, accountId }) => {
    const id =
      accountId && normalizeAccountId(accountId)
        ? normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID
        : resolveDefaultWeComAccountId(cfg as ClawdbotConfig);
    
    const allowFrom = await prompter.text({
      message: "Enter WeCom user IDs to allow (comma-separated, or * for all)",
      placeholder: "userid1,userid2 or *",
    });

    const entries = allowFrom
      ?.trim()
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean) ?? [];

    if (entries.length === 0) {
      return cfg;
    }

    const wecomConfig = (cfg.channels?.wecom as WeComConfig | undefined) ?? {};
    const isDefault = id === DEFAULT_ACCOUNT_ID;
    if (isDefault) {
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          wecom: {
            ...wecomConfig,
            allowFrom: entries,
          },
        },
      } as ClawdbotConfig;
    }

    const accounts = { ...(wecomConfig.accounts ?? {}) };
    accounts[id] = {
      ...accounts[id],
      allowFrom: entries,
    };

    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        wecom: {
          ...wecomConfig,
          accounts,
        },
      },
    } as ClawdbotConfig;
  },
};

export const wecomOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const configured = listWeComAccountIds(cfg as ClawdbotConfig).some((accountId) =>
      resolveWeComAccount({ cfg: cfg as ClawdbotConfig, accountId }).configured,
    );
    return {
      channel,
      configured,
      statusLines: [`WeCom: ${configured ? "configured" : "needs corpId/agentId/secret"}`],
      selectionHint: configured ? "configured" : "needs configuration",
      quickstartScore: configured ? 1 : 10,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds, forceAllowFrom }) => {
    const wecomOverride = accountOverrides.wecom?.trim();
    const defaultWeComAccountId = resolveDefaultWeComAccountId(cfg as ClawdbotConfig);
    let wecomAccountId = wecomOverride
      ? normalizeAccountId(wecomOverride)
      : defaultWeComAccountId;
    
    if (shouldPromptAccountIds && !wecomOverride) {
      wecomAccountId = await promptAccountId({
        cfg: cfg as ClawdbotConfig,
        prompter,
        label: "WeCom",
        currentId: wecomAccountId,
        listAccountIds: listWeComAccountIds,
        defaultAccountId: defaultWeComAccountId,
      });
    }

    let next = cfg as ClawdbotConfig;
    const resolvedAccount = resolveWeComAccount({ cfg: next, accountId: wecomAccountId });
    const accountConfigured = resolvedAccount.configured;

    // 提示输入配置信息
    if (!accountConfigured) {
      await prompter.note(
        "You need to configure:\n" +
          "1. CorpId (企业ID) - from WeCom admin console\n" +
          "2. AgentId (应用ID) - from WeCom app management\n" +
          "3. Secret (应用密钥) - from WeCom app management",
        "WeCom Configuration",
      );
    }

    let corpId: string | undefined;
    let agentId: string | undefined;
    let secret: string | undefined;

    if (!accountConfigured || !resolvedAccount.corpId) {
      const keepExisting = accountConfigured && resolvedAccount.corpId
        ? await prompter.confirm({
            message: `Keep existing CorpId (${resolvedAccount.corpId})?`,
            initialValue: true,
          })
        : false;

      if (!keepExisting) {
        corpId = String(
          await prompter.text({
            message: "Enter WeCom CorpId (企业ID)",
            validate: (value: string | undefined) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      } else {
        corpId = resolvedAccount.corpId;
      }
    } else {
      corpId = resolvedAccount.corpId;
    }

    if (!accountConfigured || !resolvedAccount.agentId) {
      const keepExisting = accountConfigured && resolvedAccount.agentId
        ? await prompter.confirm({
            message: `Keep existing AgentId (${resolvedAccount.agentId})?`,
            initialValue: true,
          })
        : false;

      if (!keepExisting) {
        agentId = String(
          await prompter.text({
            message: "Enter WeCom AgentId (应用ID)",
            validate: (value: string | undefined) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      } else {
        agentId = resolvedAccount.agentId;
      }
    } else {
      agentId = resolvedAccount.agentId;
    }

    if (!accountConfigured || !resolvedAccount.secret) {
      const keepExisting = accountConfigured && resolvedAccount.secret
        ? await prompter.confirm({
            message: "Keep existing Secret?",
            initialValue: true,
          })
        : false;

      if (!keepExisting) {
        secret = String(
          await prompter.text({
            message: "Enter WeCom Secret (应用密钥)",
            validate: (value: string | undefined) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      } else {
        secret = resolvedAccount.secret;
      }
    } else {
      secret = resolvedAccount.secret;
    }

    // 验证配置
    if (corpId && agentId && secret) {
      await prompter.note("Verifying WeCom configuration...", "Verifying");
      
      const probeResult = await probeWeCom(corpId, agentId, secret);
      
      if (probeResult.ok && probeResult.agent) {
        await prompter.note(
          `✓ Configuration verified!\n` +
            `  Agent: ${probeResult.agent.name}\n` +
            `  AgentId: ${probeResult.agent.agentid}`,
          "Success",
        );
      } else {
        await prompter.note(
          `⚠ Verification failed: ${probeResult.error}\n` +
            `  Please check your CorpId, AgentId, and Secret.`,
          "Warning",
        );
      }
    }

    // 应用配置
    const wecomConfig = (next.channels?.wecom as WeComConfig | undefined) ?? {};
    const isDefault = wecomAccountId === DEFAULT_ACCOUNT_ID;
    if (isDefault) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          wecom: {
            ...wecomConfig,
            corpId,
            agentId,
            secret,
            enabled: true,
          },
        },
      } as ClawdbotConfig;
    } else {
      const accounts = { ...(wecomConfig.accounts ?? {}) };
      accounts[wecomAccountId] = {
        ...accounts[wecomAccountId],
        corpId,
        agentId,
        secret,
        enabled: true,
      };
      next = {
        ...next,
        channels: {
          ...next.channels,
          wecom: {
            ...wecomConfig,
            accounts,
          },
        },
      } as ClawdbotConfig;
    }

    // 配置 DM 策略（使用默认策略，如果需要可以后续添加提示）
    const currentPolicy = dmPolicy.getCurrent(next);
    if (currentPolicy === "pairing") {
      // 保持默认策略
    }

    // 配置 allowFrom（如果需要）
    if (forceAllowFrom && dmPolicy.promptAllowFrom) {
      next = await dmPolicy.promptAllowFrom({ cfg: next, prompter, accountId: wecomAccountId });
    }

    return { cfg: next, accountId: wecomAccountId };
  },
};
