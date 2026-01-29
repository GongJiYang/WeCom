import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const wecomAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  corpId: z.string().optional(),
  agentId: z.string().optional(),
  secret: z.string().optional(),
  secretFile: z.string().optional(),
  webhookUrl: z.string().optional(),
  webhookToken: z.string().optional(),
  encodingAESKey: z.string().optional(),
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(allowFromEntry).optional(),
  groupPolicy: z.enum(["allowlist", "open", "disabled"]).optional(),
  groupAllowFrom: z.array(allowFromEntry).optional(),
  mediaMaxMb: z.number().optional(),
  textChunkLimit: z.number().optional(),
  blockStreaming: z.boolean().optional(),
});

export const WeComConfigSchema = wecomAccountSchema.extend({
  accounts: z.object({}).catchall(wecomAccountSchema).optional(),
  defaultAccount: z.string().optional(),
});
