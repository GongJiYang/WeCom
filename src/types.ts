/**
 * 企业微信账户配置类型
 */
export type WeComAccountConfig = {
  /** 可选显示名称（用于 CLI/UI 列表） */
  name?: string;
  /** 如果为 false，不启动此账户。默认: true */
  enabled?: boolean;
  /** 企业ID（CorpId） */
  corpId?: string;
  /** 应用ID（AgentId） */
  agentId?: string;
  /** 应用密钥（Secret） */
  secret?: string;
  /** 包含密钥的文件路径 */
  secretFile?: string;
  /** Webhook URL（用于接收消息回调） */
  webhookUrl?: string;
  /** Webhook Token（用于验证请求） */
  webhookToken?: string;
  /** Webhook EncodingAESKey（用于消息加解密） */
  encodingAESKey?: string;
  /** 私信访问策略（默认: pairing） */
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  /** DM 发送者白名单（企业微信用户ID） */
  allowFrom?: Array<string | number>;
  /** 群组访问策略 */
  groupPolicy?: "allowlist" | "open" | "disabled";
  /** 群组白名单 */
  groupAllowFrom?: Array<string | number>;
  /** 最大入站媒体大小（MB） */
  mediaMaxMb?: number;
  /** 文本分块限制 */
  textChunkLimit?: number;
  /** 是否阻止流式传输 */
  blockStreaming?: boolean;
};

/**
 * 企业微信配置类型
 */
export type WeComConfig = {
  /** 可选的多账户配置 */
  accounts?: Record<string, WeComAccountConfig>;
  /** 多个账户配置时的默认账户ID */
  defaultAccount?: string;
} & WeComAccountConfig;

/**
 * 密钥来源类型
 */
export type WeComSecretSource = "env" | "config" | "configFile" | "none";

/**
 * 解析后的企业微信账户类型
 * 这是从配置中解析出来的完整账户信息
 */
export type ResolvedWeComAccount = {
  /** 账户ID */
  accountId: string;
  /** 账户名称 */
  name?: string;
  /** 是否启用 */
  enabled: boolean;
  /** 企业ID */
  corpId: string;
  /** 应用ID */
  agentId: string;
  /** 应用密钥 */
  secret: string;
  /** 密钥来源 */
  secretSource: WeComSecretSource;
  /** 原始配置 */
  config: WeComAccountConfig;
  /** 是否已配置（至少需要 corpId, agentId, secret） */
  configured: boolean;
  /** Webhook URL */
  webhookUrl?: string;
  /** Webhook Token */
  webhookToken?: string;
  /** Webhook EncodingAESKey */
  encodingAESKey?: string;
  /** 私信策略 */
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  /** 允许发送者列表 */
  allowFrom?: string[];
  /** 群组策略 */
  groupPolicy?: "allowlist" | "open" | "disabled";
  /** 群组允许发送者列表 */
  groupAllowFrom?: string[];
  /** 最大媒体大小（MB） */
  mediaMaxMb?: number;
  /** 文本分块限制 */
  textChunkLimit?: number;
  /** 是否阻止流式传输 */
  blockStreaming?: boolean;
};
