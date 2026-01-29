import * as fs from "node:fs";

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "clawdbot/plugin-sdk";

import type {
  ResolvedWeComAccount,
  WeComAccountConfig,
  WeComConfig,
  WeComSecretSource,
} from "./types.js";

function listConfiguredAccountIds(cfg: ClawdbotConfig): string[] {
  const accounts = (cfg.channels?.wecom as WeComConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(Boolean);
}

export function listWeComAccountIds(cfg: ClawdbotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultWeComAccountId(cfg: ClawdbotConfig): string {
  const ids = listWeComAccountIds(cfg);
  const rootCfg = cfg.channels?.wecom as WeComConfig | undefined;
  const defaultAccount = rootCfg?.defaultAccount?.trim();
  if (defaultAccount && ids.includes(defaultAccount)) {
    return defaultAccount;
  }
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): WeComAccountConfig | undefined {
  const rootCfg = cfg.channels?.wecom as WeComConfig | undefined;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    // 对于默认账户，返回根配置（如果存在）
    if (rootCfg && (rootCfg.corpId || rootCfg.agentId || rootCfg.secret)) {
      return rootCfg;
    }
    return undefined;
  }
  const accounts = rootCfg?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  return accounts[accountId] as WeComAccountConfig | undefined;
}

function readFileIfExists(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  try {
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return undefined;
  }
}

function resolveSecret(params: {
  accountId: string;
  rootCfg?: WeComConfig;
  accountCfg?: WeComAccountConfig;
}): { secret: string; source: WeComSecretSource } {
  const { accountId, rootCfg, accountCfg } = params;

  // 优先检查账户级配置
  if (accountCfg?.secret?.trim()) {
    return { secret: accountCfg.secret.trim(), source: "config" };
  }

  // 检查账户级密钥文件
  const accountFileSecret = readFileIfExists(accountCfg?.secretFile);
  if (accountFileSecret) {
    return { secret: accountFileSecret, source: "configFile" };
  }

  // 对于默认账户，检查根配置和环境变量
  if (accountId === DEFAULT_ACCOUNT_ID) {
    if (rootCfg?.secret?.trim()) {
      return { secret: rootCfg.secret.trim(), source: "config" };
    }

    const rootFileSecret = readFileIfExists(rootCfg?.secretFile);
    if (rootFileSecret) {
      return { secret: rootFileSecret, source: "configFile" };
    }

    const envSecret = process.env.WECOM_SECRET?.trim();
    if (envSecret) {
      return { secret: envSecret, source: "env" };
    }
  }

  return { secret: "", source: "none" };
}

function normalizeAllowFrom(
  allowFrom?: Array<string | number>,
): string[] | undefined {
  if (!allowFrom || allowFrom.length === 0) return undefined;
  return allowFrom.map((item) => String(item));
}

export function resolveWeComAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedWeComAccount {
  const rootCfg = params.cfg.channels?.wecom as WeComConfig | undefined;
  const accountId = params.accountId?.trim() || resolveDefaultWeComAccountId(params.cfg);
  const accountCfg = resolveAccountConfig(params.cfg, accountId);

  // 先解析密钥（使用未合并的配置以确保优先级正确）
  const { secret, source: secretSource } = resolveSecret({
    accountId,
    rootCfg,
    accountCfg,
  });

  // 合并配置：账户级配置优先，然后使用根配置作为默认值
  const mergedCfg: WeComAccountConfig = {
    name: accountCfg?.name ?? rootCfg?.name,
    enabled: accountCfg?.enabled ?? rootCfg?.enabled,
    corpId: accountCfg?.corpId ?? rootCfg?.corpId,
    agentId: accountCfg?.agentId ?? rootCfg?.agentId,
    secret: accountCfg?.secret ?? rootCfg?.secret,
    secretFile: accountCfg?.secretFile ?? rootCfg?.secretFile,
    webhookUrl: accountCfg?.webhookUrl ?? rootCfg?.webhookUrl,
    webhookToken: accountCfg?.webhookToken ?? rootCfg?.webhookToken,
    encodingAESKey: accountCfg?.encodingAESKey ?? rootCfg?.encodingAESKey,
    dmPolicy: accountCfg?.dmPolicy ?? rootCfg?.dmPolicy,
    allowFrom: accountCfg?.allowFrom ?? rootCfg?.allowFrom,
    groupPolicy: accountCfg?.groupPolicy ?? rootCfg?.groupPolicy,
    groupAllowFrom: accountCfg?.groupAllowFrom ?? rootCfg?.groupAllowFrom,
    mediaMaxMb: accountCfg?.mediaMaxMb ?? rootCfg?.mediaMaxMb,
    textChunkLimit: accountCfg?.textChunkLimit ?? rootCfg?.textChunkLimit,
    blockStreaming: accountCfg?.blockStreaming ?? rootCfg?.blockStreaming,
  };

  const enabled = mergedCfg.enabled !== false;

  // 解析企业ID和应用ID（配置里可能被写成 number，这里做健壮归一化）
  const corpId = String(mergedCfg.corpId ?? "").trim();
  const agentId = String(mergedCfg.agentId ?? "").trim();

  // 检查是否已配置（至少需要 corpId, agentId, secret）
  const configured = Boolean(corpId && agentId && secret);

  return {
    accountId,
    name: mergedCfg.name?.trim() || undefined,
    enabled,
    corpId,
    agentId,
    secret,
    secretSource,
    config: mergedCfg,
    configured,
    webhookUrl: mergedCfg.webhookUrl?.trim() || undefined,
    webhookToken: mergedCfg.webhookToken?.trim() || undefined,
    encodingAESKey: mergedCfg.encodingAESKey?.trim() || undefined,
    dmPolicy: mergedCfg.dmPolicy ?? rootCfg?.dmPolicy,
    allowFrom: normalizeAllowFrom(mergedCfg.allowFrom ?? rootCfg?.allowFrom),
    groupPolicy: mergedCfg.groupPolicy ?? rootCfg?.groupPolicy,
    groupAllowFrom: normalizeAllowFrom(
      mergedCfg.groupAllowFrom ?? rootCfg?.groupAllowFrom,
    ),
    mediaMaxMb: mergedCfg.mediaMaxMb ?? rootCfg?.mediaMaxMb,
    textChunkLimit: mergedCfg.textChunkLimit ?? rootCfg?.textChunkLimit,
    blockStreaming: mergedCfg.blockStreaming ?? rootCfg?.blockStreaming,
  };
}

export function listEnabledWeComAccounts(
  cfg: ClawdbotConfig,
): ResolvedWeComAccount[] {
  return listWeComAccountIds(cfg)
    .map((accountId) => resolveWeComAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
