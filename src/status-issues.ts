import type { ChannelAccountSnapshot, ChannelStatusIssue } from "clawdbot/plugin-sdk";

type WeComAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
  dmPolicy?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object");

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;

function readWeComAccountStatus(value: ChannelAccountSnapshot): WeComAccountStatus | null {
  if (!isRecord(value)) return null;
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    configured: value.configured,
    dmPolicy: value.dmPolicy,
  };
}

export function collectWeComStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readWeComAccountStatus(entry);
    if (!account) continue;
    const accountId = asString(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    const configured = account.configured === true;
    if (!enabled || !configured) continue;

    if (account.dmPolicy === "open") {
      issues.push({
        channel: "wecom",
        accountId,
        kind: "config",
        message:
          'WeCom dmPolicy is "open", allowing any user to message the bot without pairing.',
        fix: 'Set channels.wecom.dmPolicy to "pairing" or "allowlist" to restrict access.',
      });
    }

  }
  return issues;
}
