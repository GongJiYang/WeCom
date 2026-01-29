import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";

import type { ResolvedWeComAccount } from "./types.js";
import { resolveWeComAccount } from "./accounts.js";
import { getWeComRuntime } from "./runtime.js";
import { sendMessageWeCom } from "./send.js";

export type WeComRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type WeComMonitorOptions = {
  account: ResolvedWeComAccount;
  config: ClawdbotConfig;
  runtime: WeComRuntimeEnv;
  abortSignal: AbortSignal;
  webhookUrl?: string;
  webhookToken?: string;
  webhookPath?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type WeComMonitorResult = {
  stop: () => void;
};

type WeComCoreRuntime = ReturnType<typeof getWeComRuntime>;

// Webhook 路径到目标的映射
const webhookTargets = new Map<string, Array<{
  account: ResolvedWeComAccount;
  config: ClawdbotConfig;
  runtime: WeComRuntimeEnv;
  core: WeComCoreRuntime;
  token: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}>>();

function normalizeWebhookPath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

/**
 * 验证企业微信 webhook 签名
 * 签名算法：SHA1(token + timestamp + nonce + encrypted_msg)
 * @see https://developer.work.weixin.qq.com/document/path/101033
 */
function verifyWeComSignature(params: {
  token: string;
  timestamp: string;
  nonce: string;
  encryptedMsg: string;
  signature: string;
}): boolean {
  const { token, timestamp, nonce, encryptedMsg, signature } = params;
  if (!token || !timestamp || !nonce || !encryptedMsg || !signature) {
    return false;
  }

  // 按字典序排序并拼接
  const sorted = [token, timestamp, nonce, encryptedMsg].sort();
  const str = sorted.join("");

  // SHA1 哈希
  const hash = crypto.createHash("sha1").update(str).digest("hex");

  // 使用 timing-safe 比较防止时序攻击
  if (hash.length !== signature.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < hash.length; i++) {
    result |= hash.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

function logVerbose(core: WeComCoreRuntime, runtime: WeComRuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[wecom] ${message}`);
  }
}

/**
 * 解密企业微信加密消息（AES-256-CBC）
 * @param encryptedMsg Base64 编码的加密消息
 * @param encodingAESKey 43 位的 Base64 编码的 AES Key
 * @param corpId 企业 ID（用于验证 receiveid，可选）
 * @returns 解密后的明文消息，如果解密失败返回 null
 * @see https://developer.work.weixin.qq.com/document/path/101033
 * 
 * 企业微信加密格式：
 * - encodingAESKey: 43 位 Base64 编码的 AES Key（解码后 32 字节）
 * - IV: encodingAESKey 的前 16 字节
 * - 加密消息格式：Base64(Encrypt(AES256_Encrypt[random(16B) + msg_len(4B) + msg + $CorpID]))
 * - 解密后格式：random(16字节) + msg_len(4字节网络字节序) + msg + receiveid
 */
function decryptWeComMessage(
  encryptedMsg: string,
  encodingAESKey: string,
  corpId?: string,
): string | null {
  try {
    // 1. Base64 解码 encodingAESKey（43 位 -> 32 字节）
    // 注意：43 位 Base64 字符串需要补一个 '=' 才能正确解码
    let aesKeyBase64 = encodingAESKey;
    if (aesKeyBase64.length === 43) {
      aesKeyBase64 += "=";
    }
    const aesKey = Buffer.from(aesKeyBase64, "base64");
    if (aesKey.length !== 32) {
      return null;
    }

    // 2. IV 是 encodingAESKey 的前 16 字节
    const iv = aesKey.subarray(0, 16);

    // 3. Base64 解码加密消息
    const encrypted = Buffer.from(encryptedMsg, "base64");
    if (encrypted.length === 0) {
      return null;
    }

    // 4. AES-256-CBC 解密
    const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    // 5. 解析解密后的数据格式：random(16字节) + msg_len(4字节网络字节序) + msg + receiveid
    if (decrypted.length < 20) {
      return null;
    }

    // 跳过 random（前 16 字节）
    const msgLenBuffer = decrypted.subarray(16, 20);
    const msgLen = msgLenBuffer.readUInt32BE(0);

    // 验证消息长度
    if (msgLen < 0 || msgLen > decrypted.length - 20) {
      return null;
    }

    // 提取 msg
    const msg = decrypted.subarray(20, 20 + msgLen).toString("utf8");

    // 提取 receiveid（剩余部分）
    const receiveid = decrypted.subarray(20 + msgLen).toString("utf8");

    // 如果提供了 corpId，验证 receiveid 是否匹配（企业微信中 receiveid 通常是 $CorpID）
    if (corpId && receiveid && receiveid !== corpId && receiveid !== `$${corpId}`) {
      // 允许 receiveid 是 $CorpID 格式
      return null;
    }

    return msg;
  } catch (err) {
    return null;
  }
}

/**
 * 读取请求体（支持 JSON 和 XML）
 */
async function readRequestBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string; raw?: string }>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({ ok: false, error: "empty payload" });
          return;
        }
        // 尝试解析为 JSON
        try {
          resolve({ ok: true, value: JSON.parse(raw) as unknown, raw });
        } catch {
          // 如果不是 JSON，返回原始字符串（可能是 XML）
          resolve({ ok: true, value: { raw }, raw });
        }
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

/**
 * 简单的 XML 解析函数（解析企业微信 XML 消息）
 * 企业微信 XML 格式示例：
 * <xml>
 *   <ToUserName><![CDATA[toUser]]></ToUserName>
 *   <FromUserName><![CDATA[fromUser]]></FromUserName>
 *   <CreateTime>1348831860</CreateTime>
 *   <MsgType><![CDATA[text]]></MsgType>
 *   <Content><![CDATA[this is a test]]></Content>
 *   <MsgId>1234567890123456</MsgId>
 * </xml>
 */
function parseWeComXML(xml: string): Record<string, unknown> | null {
  try {
    const result: Record<string, unknown> = {};
    // 简单的 XML 解析（使用正则表达式提取标签内容）
    // 匹配 <TagName><![CDATA[value]]></TagName> 或 <TagName>value</TagName>
    const tagRegex = /<(\w+)><!\[CDATA\[(.*?)\]\]><\/\1>|<(\w+)>(.*?)<\/\3>/g;
    let match;
    while ((match = tagRegex.exec(xml)) !== null) {
      const tagName = match[1] || match[3];
      const value = match[2] || match[4];
      if (tagName && value !== undefined) {
        // 尝试转换为数字（如果是数字字符串）
        const numValue = Number(value);
        result[tagName] = isNaN(numValue) ? value : numValue;
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) return true;
  const normalizedSenderId = senderId.toLowerCase();
  return allowFrom.some((entry) => {
    const normalized = entry.toLowerCase().replace(/^(wecom|wc):/i, "");
    return normalized === normalizedSenderId;
  });
}

async function processWeComMessage(params: {
  payload: Record<string, unknown>;
  target: {
    account: ResolvedWeComAccount;
    config: ClawdbotConfig;
    runtime: WeComRuntimeEnv;
    core: WeComCoreRuntime;
    statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  };
}): Promise<void> {
  const { payload, target } = params;
  const { account, config, runtime, core, statusSink } = target;

  // 解析消息字段
  const fromUserId = typeof payload.FromUserName === "string" ? payload.FromUserName : "";
  const toCorpId = typeof payload.ToUserName === "string" ? payload.ToUserName : "";
  const content = typeof payload.Content === "string" ? payload.Content : "";
  const msgId = typeof payload.MsgId === "string" ? payload.MsgId : String(payload.MsgId ?? "");
  const createTime = typeof payload.CreateTime === "number" ? payload.CreateTime : Date.now() / 1000;
  const agentId = typeof payload.AgentID === "string" ? payload.AgentID : account.agentId;

  // 验证 AgentID 是否匹配
  if (agentId !== account.agentId) {
    logVerbose(core, runtime, `WeCom: drop message from mismatched agentId ${agentId}`);
    return;
  }

  const rawBody = content.trim();
  if (!rawBody) return;

  // 判断是否为群组消息
  // 企业微信中，如果 FromUserName 以 @chatroom 结尾，则为群组消息
  // 或者根据消息类型判断（ChatInfo 字段可能包含群组信息）
  const isGroup = fromUserId.endsWith("@chatroom") || 
    typeof payload.ChatInfo === "object" ||
    (typeof payload.MsgType === "string" && payload.MsgType.includes("chatroom"));

  const dmPolicy = account.dmPolicy ?? "pairing";
  const configAllowFrom = account.allowFrom ?? [];
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
  const storeAllowFrom =
    !isGroup && (dmPolicy !== "open" || shouldComputeAuth)
      ? await core.channel.pairing.readAllowFromStore("wecom").catch(() => [])
      : [];
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isSenderAllowed(fromUserId, effectiveAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: effectiveAllowFrom.length > 0, allowed: senderAllowedForCommands },
        ],
      })
    : undefined;

  // 检查 DM 策略
  if (!isGroup) {
    if (dmPolicy === "disabled") {
      logVerbose(core, runtime, `Blocked WeCom DM from ${fromUserId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const allowed = senderAllowedForCommands;

      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "wecom",
            id: fromUserId,
            meta: { name: fromUserId },
          });

          if (created) {
            logVerbose(core, runtime, `WeCom pairing request sender=${fromUserId}`);
            try {
              await sendMessageWeCom(fromUserId, core.channel.pairing.buildPairingReply({
                channel: "wecom",
                idLine: `Your WeCom user id: ${fromUserId}`,
                code,
              }), {
                accountId: account.accountId,
                cfg: config,
              });
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerbose(
                core,
                runtime,
                `WeCom pairing reply failed for ${fromUserId}: ${String(err)}`,
              );
            }
          }
        } else {
          logVerbose(
            core,
            runtime,
            `Blocked unauthorized WeCom sender ${fromUserId} (dmPolicy=${dmPolicy})`,
          );
        }
        return;
      }
    }
  }

  // 路由到 agent
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: fromUserId,
    },
  });

  // 检查控制命令权限
  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(core, runtime, `WeCom: drop control command from unauthorized sender ${fromUserId}`);
    return;
  }

  const fromLabel = isGroup ? `group:${fromUserId}` : `user:${fromUserId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "WeCom",
    from: fromLabel,
    timestamp: createTime * 1000,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `wecom:group:${fromUserId}` : `wecom:${fromUserId}`,
    To: isGroup ? `wecom:group:${fromUserId}` : `wecom:${account.corpId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: fromUserId,
    SenderId: fromUserId,
    CommandAuthorized: commandAuthorized,
    Provider: "wecom",
    Surface: "wecom",
    MessageSid: msgId,
    OriginatingChannel: "wecom",
    OriginatingTo: `wecom:${fromUserId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`WeCom: failed updating session meta: ${String(err)}`);
    },
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverWeComReply({
          payload,
          to: fromUserId,
          account,
          runtime,
          core,
          config,
          statusSink,
          tableMode,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`[${account.accountId}] WeCom ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

async function deliverWeComReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  to: string;
  account: ResolvedWeComAccount;
  runtime: WeComRuntimeEnv;
  core: WeComCoreRuntime;
  config: ClawdbotConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  tableMode?: "off" | "bullets" | "code";
}): Promise<void> {
  const { payload, to, account, runtime, core, config, statusSink, tableMode } = params;
  const text = core.channel.text.convertMarkdownTables(
    payload.text ?? "",
    tableMode ?? "code",
  );

  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  if (mediaList.length > 0) {
    // 发送媒体消息
    const { sendMediaWeCom } = await import("./send.js");
    // 如果有文本，先发送文本
    if (text) {
      try {
        await sendMessageWeCom(to, text, {
          accountId: account.accountId,
          cfg: config,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`WeCom text send failed: ${String(err)}`);
      }
    }
    // 然后发送所有媒体
    for (const mediaUrl of mediaList) {
      try {
        await sendMediaWeCom(to, mediaUrl, {
          accountId: account.accountId,
          cfg: config,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`WeCom media send failed: ${String(err)}`);
      }
    }
    return;
  }

  if (text) {
    const chunkMode = core.channel.text.resolveChunkMode(config, "wecom", account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(
      text,
      account.textChunkLimit ?? 2048,
      chunkMode,
    );
    for (const chunk of chunks) {
      try {
        await sendMessageWeCom(to, chunk, {
          accountId: account.accountId,
          cfg: config,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`WeCom message send failed: ${String(err)}`);
      }
    }
  }
}

/**
 * 处理企业微信 webhook 请求
 * 企业微信 webhook 使用 URL 参数验证（msg_signature, timestamp, nonce, echostr）
 * 以及可选的 token 验证
 */
export async function handleWeComWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  
  // 调试日志：记录所有请求（包括路径不匹配的情况）
  const runtime = getWeComRuntime();
  runtime.log?.(`[wecom] HTTP handler called: method=${req.method}, path=${path}, url.pathname=${url.pathname}`);
  
  // 检查路径是否匹配 wecom webhook 路径
  if (!path.startsWith("/webhook/wecom/")) {
    runtime.log?.(`[wecom] Path ${path} does not match wecom webhook pattern, returning false`);
    return false;
  }

  // 企业微信 webhook 验证（GET 请求用于验证，POST 用于接收消息）
  if (req.method === "GET") {
    // URL 验证请求
    const echostr = url.searchParams.get("echostr");
    const msgSignature = url.searchParams.get("msg_signature");
    const timestamp = url.searchParams.get("timestamp");
    const nonce = url.searchParams.get("nonce");

    // 如果没有 echostr，返回 ok（兼容性处理）
    if (!echostr) {
      res.statusCode = 200;
      res.end("ok");
      return true;
    }

    // 尝试从已注册的 targets 获取 account 配置
    const targets = webhookTargets.get(path);
    let account: ResolvedWeComAccount | null = null;
    
    if (targets && targets.length > 0) {
      account = targets[0].account;
    } else {
      // 如果 targets 不存在，从配置中读取（用于 URL 验证时 account 可能还没启动）
      try {
        const config = getWeComRuntime().config.loadConfig();
        const resolved = resolveWeComAccount({ cfg: config });
        if (resolved.configured) {
          account = resolved;
        }
      } catch {
        // 忽略配置读取错误
      }
    }

    // 如果配置了 webhookToken，需要验证签名
    if (account?.webhookToken && msgSignature && timestamp && nonce) {
      const isValid = verifyWeComSignature({
        token: account.webhookToken,
        timestamp,
        nonce,
        encryptedMsg: echostr, // GET 请求时，echostr 就是加密消息
        signature: msgSignature,
      });

      if (!isValid) {
        res.statusCode = 401;
        res.end("unauthorized");
        return true;
      }
    }

    // 如果配置了 encodingAESKey，需要解密 echostr
    if (account?.encodingAESKey) {
      const decryptedEchostr = decryptWeComMessage(echostr, account.encodingAESKey, account.corpId);
      if (!decryptedEchostr) {
        // 解密失败，返回错误
        res.statusCode = 400;
        res.end("decrypt failed");
        return true;
      }
      // 返回解密后的明文（不能加引号、不能带 BOM 头、不能带换行符）
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(decryptedEchostr);
      return true;
    }

    // 没有配置 encodingAESKey，直接返回 echostr
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(echostr);
    return true;
  }

  // POST 请求需要已注册的 targets
  const targets = webhookTargets.get(path);
  runtime.log?.(`[wecom] Looking for targets for path: ${path}, found: ${targets?.length ?? 0}`);
  if (!targets || targets.length === 0) {
    runtime.log?.(`[wecom] No targets found for path: ${path}, registered paths: ${Array.from(webhookTargets.keys()).join(", ")}`);
    return false;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end("Method Not Allowed");
    return true;
  }

  // POST 请求需要已注册的 targets（account 必须已启动）
  if (!targets || targets.length === 0) return false;

  // 验证 token（如果配置了）
  const tokenParam = url.searchParams.get("token");
  const target = targets.find((entry) => {
    if (!entry.account.webhookToken) return true; // 如果没有配置 token，允许所有
    return entry.account.webhookToken === tokenParam;
  });

  if (!target && tokenParam) {
    runtime.log?.(`[wecom] Token mismatch: received=${tokenParam}, expected=${targets[0]?.account.webhookToken || "none"}`);
    res.statusCode = 401;
    res.end("unauthorized");
    return true;
  }

  const selectedTarget = target ?? targets[0];

  // 读取请求体（用于签名验证和解析，支持 JSON 和 XML）
  const bodyResult = await readRequestBody(req, 1024 * 1024);
  if (!bodyResult.ok) {
    res.statusCode = bodyResult.error === "payload too large" ? 413 : 400;
    res.end(bodyResult.error ?? "invalid payload");
    return true;
  }

  let payload = bodyResult.value as Record<string, unknown>;
  const rawBody = bodyResult.raw ?? "";

  // 如果是 XML 格式（原始字符串），尝试解析
  if (payload.raw && typeof payload.raw === "string" && payload.raw.trim().startsWith("<")) {
    const xmlPayload = parseWeComXML(payload.raw);
    if (xmlPayload) {
      payload = xmlPayload;
    }
  }

  // 验证签名（如果配置了 webhookToken）
  const msgSignature = url.searchParams.get("msg_signature");
  const timestamp = url.searchParams.get("timestamp");
  const nonce = url.searchParams.get("nonce");

  if (selectedTarget.account.webhookToken && msgSignature && timestamp && nonce) {
    // 企业微信 POST 请求可能是 XML 格式，需要提取 Encrypt 字段
    // 如果是 JSON 格式，直接使用整个 body 的字符串形式
    let encryptedMsg = "";
    if (typeof payload.Encrypt === "string") {
      encryptedMsg = payload.Encrypt;
    } else if (rawBody && rawBody.trim().startsWith("<")) {
      // XML 格式，从原始 XML 中提取 Encrypt 标签
      const encryptMatch = rawBody.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>|<Encrypt>(.*?)<\/Encrypt>/);
      if (encryptMatch) {
        encryptedMsg = encryptMatch[1] || encryptMatch[2] || "";
      } else {
        // 如果没有 Encrypt 字段，使用整个 body 的字符串形式
        encryptedMsg = rawBody;
      }
    } else {
      // 如果没有 Encrypt 字段，使用整个 payload 的 JSON 字符串
      encryptedMsg = JSON.stringify(payload);
    }

    const isValid = verifyWeComSignature({
      token: selectedTarget.account.webhookToken,
      timestamp,
      nonce,
      encryptedMsg,
      signature: msgSignature,
    });

    if (!isValid) {
      logVerbose(selectedTarget.core, selectedTarget.runtime, "WeCom webhook signature verification failed");
      res.statusCode = 401;
      res.end("unauthorized");
      return true;
    }
  }

  // 企业微信 webhook 消息格式
  // 如果配置了 encodingAESKey，需要解密消息
  let encryptedValue: string | undefined;
  if (typeof payload.Encrypt === "string") {
    encryptedValue = payload.Encrypt;
  } else if (rawBody && rawBody.trim().startsWith("<")) {
    // XML 格式，从原始 XML 中提取 Encrypt 标签
    const encryptMatch = rawBody.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>|<Encrypt>(.*?)<\/Encrypt>/);
    if (encryptMatch) {
      encryptedValue = encryptMatch[1] || encryptMatch[2] || undefined;
    }
  }

  if (selectedTarget.account.encodingAESKey && encryptedValue) {
    const decryptedMsg = decryptWeComMessage(
      encryptedValue,
      selectedTarget.account.encodingAESKey,
      selectedTarget.account.corpId,
    );
    if (!decryptedMsg) {
      logVerbose(selectedTarget.core, selectedTarget.runtime, "WeCom message decryption failed");
      res.statusCode = 400;
      res.end("decrypt failed");
      return true;
    }

    // 解析解密后的 XML 或 JSON 消息
    try {
      // 尝试解析为 XML（企业微信通常使用 XML）
      if (decryptedMsg.trim().startsWith("<")) {
        const xmlPayload = parseWeComXML(decryptedMsg);
        if (xmlPayload) {
          payload = xmlPayload;
        } else {
          logVerbose(selectedTarget.core, selectedTarget.runtime, "WeCom XML parse failed after decryption");
          res.statusCode = 400;
          res.end("xml parse failed");
          return true;
        }
      } else {
        // 尝试解析为 JSON
        const decryptedPayload = JSON.parse(decryptedMsg) as Record<string, unknown>;
        payload = decryptedPayload;
      }
    } catch (err) {
      // 如果解析失败，记录日志并返回错误
      logVerbose(selectedTarget.core, selectedTarget.runtime, `WeCom decrypted message parse failed: ${String(err)}`);
      res.statusCode = 400;
      res.end("parse failed");
      return true;
    }
  }
  
  // 处理消息
  selectedTarget.statusSink?.({ lastInboundAt: Date.now() });
  
  // 解析企业微信消息
  const msgType = typeof payload.MsgType === "string" ? payload.MsgType : "";
  runtime.log?.(`[wecom] Processing message: msgType=${msgType}, FromUserName=${payload.FromUserName}, Content=${typeof payload.Content === "string" ? payload.Content.substring(0, 50) : "N/A"}`);
  
  if (msgType === "text") {
    processWeComMessage({
      payload,
      target: selectedTarget,
    }).catch((err) => {
      selectedTarget.runtime.error?.(
        `[${selectedTarget.account.accountId}] WeCom webhook failed: ${String(err)}`,
      );
    });
  } else {
    logVerbose(
      selectedTarget.core,
      selectedTarget.runtime,
      `webhook received unsupported msgType: ${msgType}`,
    );
  }

  res.statusCode = 200;
  res.end("ok");
  return true;
}

/**
 * 启动企业微信监控
 * 目前仅支持 webhook 模式
 */
export async function monitorWeComProvider(
  opts: WeComMonitorOptions,
): Promise<WeComMonitorResult> {
  const core = getWeComRuntime();
  const { account, config, runtime, abortSignal, webhookPath, statusSink } = opts;

  if (!account.configured) {
    throw new Error(`WeCom account "${account.accountId}" is not configured`);
  }

  const path = webhookPath ?? `/webhook/wecom/${account.accountId}`;
  const normalizedPath = normalizeWebhookPath(path);

  const target = {
    account,
    config,
    runtime,
    core,
    token: account.webhookToken ?? "",
    statusSink,
  };

  const existing = webhookTargets.get(normalizedPath) ?? [];
  webhookTargets.set(normalizedPath, [...existing, target]);

  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    const current = webhookTargets.get(normalizedPath) ?? [];
    const filtered = current.filter((entry) => entry.account.accountId !== account.accountId);
    if (filtered.length === 0) {
      webhookTargets.delete(normalizedPath);
    } else {
      webhookTargets.set(normalizedPath, filtered);
    }
  };

  abortSignal.addEventListener("abort", stop);

  runtime.log?.(`[wecom:${account.accountId}] Webhook path registered: ${normalizedPath}`);

  return { stop };
}
