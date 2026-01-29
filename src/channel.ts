import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import {
  buildChannelConfigSchema, 
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelAccountSnapshot,
  type ChannelPlugin,
} from "clawdbot/plugin-sdk";

import {
  listWeComAccountIds,
  resolveWeComAccount,
  resolveDefaultWeComAccountId,
} from "./accounts.js";
import { wecomMessageActions } from "./actions.js";
import { wecomOnboardingAdapter } from "./onboarding.js";
import { probeWeCom } from "./probe.js";
import { getWeComRuntime } from "./runtime.js";
import { sendMessageWeCom } from "./send.js";
import { collectWeComStatusIssues } from "./status-issues.js";
import { WeComConfigSchema } from "./config-schema.js";
import type { ResolvedWeComAccount, WeComConfig } from "./types.js";

// TODO: 实现企业微信通道插件定义
export const wecomPlugin: ChannelPlugin<ResolvedWeComAccount> = {
  id: "wecom",
  meta: {
    id: "wecom",
    label: "企业微信",
    selectionLabel: "企业微信 (WeCom)",
    docsPath: "/channels/wecom",
    docsLabel: "wecom",
    blurb: "企业微信消息通道集成",
    aliases: ["wecom", "wework"],
    order: 90,
    quickstartAllowFrom: true,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
  },
  onboarding: wecomOnboardingAdapter,
  configSchema: buildChannelConfigSchema(WeComConfigSchema),
  // 账户配置的 CRUD 和查询
  config: {
    // 列出所有账户ID
    listAccountIds: (cfg) => listWeComAccountIds(cfg),
    // 解析账户配置
    resolveAccount: (cfg, accountId) => resolveWeComAccount({ cfg, accountId }),
    // 默认账户ID
    defaultAccountId: (cfg) => resolveDefaultWeComAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const wecomConfig = (cfg.channels?.wecom as WeComConfig | undefined) ?? {};
      const accounts = { ...wecomConfig.accounts };
      const existing = accounts[accountKey] ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          wecom: {
            ...wecomConfig,
            accounts: {
              ...accounts,
              [accountKey]: {
                ...existing,
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const wecomConfig = (cfg.channels?.wecom as WeComConfig | undefined) ?? {};

      // Always remove the per-account entry if present.
      const accounts = { ...(wecomConfig.accounts ?? {}) };
      delete accounts[accountKey];
      const nextAccounts = Object.keys(accounts).length > 0 ? accounts : undefined;

      // Deleting "default" should also clear base-level fields on channels.wecom.*
      if (accountKey === DEFAULT_ACCOUNT_ID) {
        const {
          // Base-level account fields (single-account config sugar)
          name: _name,
          enabled: _enabled,
          corpId: _corpId,
          agentId: _agentId,
          secret: _secret,
          secretFile: _secretFile,
          webhookUrl: _webhookUrl,
          webhookToken: _webhookToken,
          encodingAESKey: _encodingAESKey,
          dmPolicy: _dmPolicy,
          allowFrom: _allowFrom,
          groupPolicy: _groupPolicy,
          groupAllowFrom: _groupAllowFrom,
          mediaMaxMb: _mediaMaxMb,
          textChunkLimit: _textChunkLimit,
          blockStreaming: _blockStreaming,
          // Keep accounts/defaultAccount (handled below) + any future fields
          ...rest
        } = wecomConfig;

        const nextDefaultAccount =
          rest.defaultAccount?.trim() === DEFAULT_ACCOUNT_ID ? undefined : rest.defaultAccount;

        const nextWecom: WeComConfig = {
          ...(rest as WeComConfig),
          ...(nextDefaultAccount ? { defaultAccount: nextDefaultAccount } : {}),
          ...(nextAccounts ? { accounts: nextAccounts } : {}),
        };

        // If nothing left under channels.wecom, drop it entirely.
        const hasAnyKey = Object.keys(nextWecom as Record<string, unknown>).length > 0;
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            wecom: hasAnyKey ? nextWecom : undefined,
          },
        };
      }

      const nextWecom: WeComConfig = {
        ...wecomConfig,
        accounts: nextAccounts,
      };

      const hasAnyKey = Object.keys(nextWecom as Record<string, unknown>).length > 0;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          wecom: hasAnyKey ? nextWecom : undefined,
        },
      };
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      // Standard snapshot fields used across channels for gating + UI/status output
      dmPolicy: account.dmPolicy,
      allowFrom: account.allowFrom,
      tokenSource: account.secretSource,
      // Avoid leaking identifiers/secrets; only indicate presence.
      webhookUrl: account.webhookUrl ? "[set]" : undefined,
      audienceType: account.corpId ? "corpId" : undefined,
      audience: account.corpId ? "[set]" : undefined,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveWeComAccount({ cfg, accountId }).allowFrom ?? [],
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const wecomConfig = cfg.channels?.wecom as WeComConfig | undefined;
      const useAccountPath = Boolean(wecomConfig?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.wecom.accounts.${resolvedAccountId}.`
        : "channels.wecom.";
      return {
        policy: account.dmPolicy ?? "pairing",
        allowFrom: account.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("wecom"),
        normalizeEntry: (raw) => {
          const trimmed = String(raw).trim();
          return trimmed || "";
        },
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      
      // 检查 DM 策略为 "open" 的风险
      if (account.dmPolicy === "open") {
        warnings.push(
          `- WeCom DM: dmPolicy="open" allows any user to trigger. Set channels.wecom.dmPolicy="allowlist" + channels.wecom.allowFrom to restrict senders.`,
        );
      }
      
      // 检查群组策略为 "open" 的风险
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy === "open") {
        const groupAllowlistConfigured =
          Boolean(account.groupAllowFrom) && (account.groupAllowFrom?.length ?? 0) > 0;
        if (groupAllowlistConfigured) {
          warnings.push(
            `- WeCom groups: groupPolicy="open" allows any member in allowed groups to trigger. Set channels.wecom.groupPolicy="allowlist" + channels.wecom.groupAllowFrom to restrict senders.`,
          );
        } else {
          warnings.push(
            `- WeCom groups: groupPolicy="open" with no channels.wecom.groupAllowFrom; any group can trigger. Set channels.wecom.groupPolicy="allowlist" + channels.wecom.groupAllowFrom to restrict.`,
          );
        }
      }
      
      // 检查配置完整性
      if (!account.configured) {
        warnings.push(
          `- WeCom account "${account.accountId}": Missing required configuration (corpId, agentId, or secret). Configure channels.wecom.corpId, channels.wecom.agentId, and channels.wecom.secret.`,
        );
      }
      
      return warnings;
    },
  },
  auth: {
    login: async ({ cfg, accountId, runtime, verbose }) => {
      const resolvedAccountId = accountId?.trim() || resolveDefaultWeComAccountId(cfg);
      const account = resolveWeComAccount({ cfg, accountId: resolvedAccountId });
      
      if (!account.configured) {
        throw new Error(
          `WeCom account "${resolvedAccountId}" is not configured. ` +
            `Please configure corpId, agentId, and secret via onboarding or config file.`,
        );
      }

      runtime.log(`[${account.accountId}] Verifying WeCom configuration...`);
      
      const probeResult = await probeWeCom(account.corpId, account.agentId, account.secret);
      
      if (!probeResult.ok) {
        throw new Error(
          `WeCom login verification failed: ${probeResult.error}. ` +
            `Please check your corpId, agentId, and secret.`,
        );
      }

      runtime.log(
        `[${account.accountId}] WeCom login successful!\n` +
          `  Agent: ${probeResult.agent?.name ?? "Unknown"}\n` +
          `  AgentId: ${account.agentId}`,
      );
    },
  },
  heartbeat: {
    checkReady: async ({ cfg, accountId }) => {
      const account = resolveWeComAccount({ cfg, accountId });
      
      if (!account.configured) {
        return { ok: false, reason: "wecom-not-configured" };
      }

      // 验证配置是否仍然有效
      const probeResult = await probeWeCom(account.corpId, account.agentId, account.secret, 5000);
      
      if (!probeResult.ok) {
        return { ok: false, reason: "wecom-auth-failed" };
      }

      return { ok: true, reason: "ok" };
    },
    resolveRecipients: ({ cfg, opts }) => {
      // 企业微信心跳接收者：从配置的 allowFrom 列表中解析
      const account = resolveWeComAccount({ cfg, accountId: undefined });
      if (!account.configured) {
        return { recipients: [], source: "none" };
      }
      const allowFrom = account.allowFrom ?? [];
      // 返回允许的用户ID列表（排除通配符）
      const recipients = allowFrom.filter((id) => id !== "*").map((id) => String(id));
      if (opts?.to) {
        return { recipients: [opts.to], source: "flag" };
      }
      if (opts?.all) {
        return { recipients, source: "all" };
      }
      return { recipients, source: "allowFrom" };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => {
      if (!text) return [];
      if (limit <= 0 || text.length <= limit) return [text];
      const chunks: string[] = [];
      let remaining = text;
      while (remaining.length > limit) {
        const window = remaining.slice(0, limit);
        const lastNewline = window.lastIndexOf("\n");
        const lastSpace = window.lastIndexOf(" ");
        let breakIdx = lastNewline > 0 ? lastNewline : lastSpace;
        if (breakIdx <= 0) breakIdx = limit;
        const rawChunk = remaining.slice(0, breakIdx);
        const chunk = rawChunk.trimEnd();
        if (chunk.length > 0) chunks.push(chunk);
        const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
        const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
        remaining = remaining.slice(nextStart).trimStart();
      }
      if (remaining.length) chunks.push(remaining);
      return chunks;
    },
    chunkerMode: "text",
    textChunkLimit: 2048, // 企业微信文本消息限制
    sendText: async ({ to, text, accountId, cfg }) => {
      const result = await sendMessageWeCom(to, text, {
        accountId: accountId ?? undefined,
        cfg: cfg as ClawdbotConfig,
      });
      return {
        channel: "wecom",
        ok: result.ok,
        messageId: result.messageId ?? "",
        error: result.error ? new Error(result.error) : undefined,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
      const result = await sendMessageWeCom(to, text || "", {
        accountId: accountId ?? undefined,
        cfg: cfg as ClawdbotConfig,
      });
      return {
        channel: "wecom",
        ok: result.ok,
        messageId: result.messageId ?? "",
        error: result.error ? new Error(result.error) : undefined,
      };
    },
  },
  actions: wecomMessageActions,
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: collectWeComStatusIssues,
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      mode: snapshot.mode ?? undefined,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      if (!account.configured) {
        return { ok: false, error: "Account not configured" };
      }
      return probeWeCom(account.corpId, account.agentId, account.secret, timeoutMs);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        tokenSource: account.secretSource,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        mode: account.webhookUrl ? "webhook" : undefined,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
        dmPolicy: account.dmPolicy ?? "pairing",
        probe,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.configured) {
        throw new Error(`WeCom account "${account.accountId}" is not configured`);
      }

      let wecomAgentLabel = "";
      try {
        const probeResult = await probeWeCom(account.corpId, account.agentId, account.secret, 2500);
        const name = probeResult.ok ? probeResult.agent?.name?.trim() : null;
        if (name) wecomAgentLabel = ` (${name})`;
        ctx.setStatus({
          accountId: account.accountId,
          running: true,
          lastStartAt: Date.now(),
        });
      } catch {
        // ignore probe errors, but still mark as running
        ctx.setStatus({
          accountId: account.accountId,
          running: true,
          lastStartAt: Date.now(),
        });
      }

      ctx.log?.info(`[${account.accountId}] starting provider${wecomAgentLabel}`);
      
      const { monitorWeComProvider } = await import("./monitor.js");
      return monitorWeComProvider({
        account,
        config: ctx.cfg as ClawdbotConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookUrl: account.webhookUrl,
        webhookToken: account.webhookToken,
        webhookPath: account.webhookUrl ? `/webhook/wecom/${account.accountId}` : undefined,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};