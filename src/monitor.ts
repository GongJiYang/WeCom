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

// 获取 logger 实例（在 handleWeComWebhookRequest 中初始化）
let wecomLogger: ReturnType<WeComCoreRuntime["logging"]["getChildLogger"]> | null = null;

function getWeComLogger(core: WeComCoreRuntime): ReturnType<WeComCoreRuntime["logging"]["getChildLogger"]> {
  if (!wecomLogger) {
    wecomLogger = core.logging.getChildLogger({ subsystem: "gateway/channels/wecom" });
  }
  return wecomLogger;
}

function logVerbose(core: WeComCoreRuntime, runtime: WeComRuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    getWeComLogger(core).debug?.(`[wecom] ${message}`);
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
  logger?: { error: (msg: string) => void; debug?: (msg: string) => void },
): string | null {
  try {
    // 去除首尾及中间空白（复制粘贴时可能带空格），避免 bad decrypt
    const rawKey = encodingAESKey.trim().replace(/\s/g, "");
    // 密文：若请求体被按 application/x-www-form-urlencoded 解析，Base64 里的 + 会变成空格，先还原再去掉换行
    let rawEnc = encryptedMsg.trim().replace(/ /g, "+").replace(/[\n\r\t]/g, "");
    // 1. Base64 解码 encodingAESKey（43 位 -> 32 字节）
    // 注意：43 位 Base64 字符串需要补一个 '=' 才能正确解码
    if (rawKey.length !== 43) {
      logger?.error(`WeCom decrypt: encodingAESKey length after trim is ${rawKey.length} (expected 43). Check for extra/missing chars or spaces in config.`);
    }
    logger?.debug?.(`WeCom decrypt: encodingAESKey length: ${rawKey.length} chars, first 10 chars: ${rawKey.substring(0, 10)}...`);
    let aesKeyBase64 = rawKey;
    if (aesKeyBase64.length === 43) {
      aesKeyBase64 += "=";
    }
    const aesKey = Buffer.from(aesKeyBase64, "base64");
    if (aesKey.length !== 32) {
      logger?.error(`WeCom decrypt: invalid encodingAESKey length (decoded: ${aesKey.length} bytes, expected: 32, input length: ${rawKey.length})`);
      return null;
    }
    logger?.debug?.(`WeCom decrypt: AES key decoded successfully (32 bytes)`);

    // 2. IV 是 encodingAESKey 的前 16 字节
    const iv = aesKey.subarray(0, 16);

    // 3. Base64 解码加密消息
    logger?.debug?.(`WeCom decrypt: encryptedMsg length: ${rawEnc.length} chars, first 20 chars: ${rawEnc.substring(0, 20)}...`);
    const encrypted = Buffer.from(rawEnc, "base64");
    if (encrypted.length === 0) {
      logger?.error("WeCom decrypt: empty encrypted message");
      return null;
    }
    logger?.debug?.(`WeCom decrypt: encrypted message length: ${encrypted.length} bytes (after base64 decode)`);

    // 4. AES-256-CBC 解密（OpenSSL 3 对 PKCS#7 校验过严，关闭自动去 padding 后手动去除）
    const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
    decipher.setAutoPadding(false);
    let decrypted: Buffer;
    try {
      decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      const padLen = decrypted[decrypted.length - 1];
      if (padLen >= 1 && padLen <= 16 && decrypted.length >= padLen) {
        decrypted = decrypted.subarray(0, decrypted.length - padLen);
      }
    } catch (decryptErr) {
      const msg = decryptErr instanceof Error ? decryptErr.message : String(decryptErr);
      logger?.error(`WeCom decrypt: AES decryption failed: ${msg}`);
      if (msg.includes("bad decrypt") || msg.includes("BAD_DECRYPT")) {
        logger?.error("WeCom decrypt: hint: ensure encodingAESKey in config exactly matches EncodingAESKey in WeCom console (43 chars, no spaces).");
      }
      return null;
    }

    // 5. 解析解密后的数据格式：random(16字节) + msg_len(4字节网络字节序) + msg + receiveid
    if (decrypted.length < 20) {
      logger?.error(`WeCom decrypt: decrypted message too short (${decrypted.length} bytes, minimum: 20)`);
      return null;
    }

    // 跳过 random（前 16 字节）
    const msgLenBuffer = decrypted.subarray(16, 20);
    const msgLen = msgLenBuffer.readUInt32BE(0);

    // 验证消息长度
    if (msgLen < 0 || msgLen > decrypted.length - 20) {
      logger?.error(`WeCom decrypt: invalid message length (${msgLen}, available: ${decrypted.length - 20})`);
      return null;
    }

    // 提取 msg
    const msg = decrypted.subarray(20, 20 + msgLen).toString("utf8");

    // 提取 receiveid（剩余部分），去掉尾部控制字符（企业微信有时会带 0x1e 等）
    const receiveidRaw = decrypted.subarray(20 + msgLen).toString("utf8");
    const receiveid = receiveidRaw.replace(/[\u0000-\u001f]+$/g, "").trim();
    logger?.debug?.(`WeCom decrypt: receiveid=${receiveid}, msgLen=${msgLen}`);

    // 如果提供了 corpId，验证 receiveid 是否匹配（企业微信中 receiveid 通常是 corpId 或 $corpId）
    if (corpId && receiveid && receiveid !== corpId && receiveid !== `$${corpId}`) {
      logger?.error(`WeCom decrypt: receiveid mismatch (received: ${receiveid}, expected: ${corpId} or $${corpId})`);
      return null;
    }

    return msg;
  } catch (err) {
    logger?.error(`WeCom decrypt: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
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
    // 匹配 <TagName><![CDATA[value]]></TagName> 或 <TagName>value</TagName>（value 可含换行，用 [\s\S]*?）
    const tagRegex = /<(\w+)><!\[CDATA\[([\s\S]*?)\]\]><\/\1>|<(\w+)>([\s\S]*?)<\/\3>/g;
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
  getWeComLogger(runtime).info(`[wecom] HTTP handler called: method=${req.method}, path=${path}, url.pathname=${url.pathname}`);
  
  // 检查路径是否匹配 wecom webhook 路径
  if (!path.startsWith("/webhook/wecom/")) {
    getWeComLogger(runtime).debug?.(`[wecom] Path ${path} does not match wecom webhook pattern, returning false`);
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
      const logger = getWeComRuntime().logging.getChildLogger({ subsystem: "gateway/channels/wecom" });
      const decryptedEchostr = decryptWeComMessage(echostr, account.encodingAESKey, account.corpId, logger);
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
  getWeComLogger(runtime).debug?.(`[wecom] Looking for targets for path: ${path}, found: ${targets?.length ?? 0}`);
  if (!targets || targets.length === 0) {
    getWeComLogger(runtime).warn(`[wecom] No targets found for path: ${path}, registered paths: ${Array.from(webhookTargets.keys()).join(", ")}`);
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

  // 选择 target（企业微信 webhook 使用签名验证，不使用 URL 参数 token）
  const selectedTarget = targets[0];

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

  // 统一提取 Encrypt 字段（用于签名验证和解密）
  let encryptedValue: string | undefined;
  if (typeof payload.Encrypt === "string") {
    encryptedValue = payload.Encrypt;
  } else if (rawBody && rawBody.trim().startsWith("<")) {
    // XML 格式，从原始 XML 中提取 Encrypt 标签（内容可能含换行，用 [\s\S]*?）
    const encryptMatch = rawBody.match(/<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>|<Encrypt>([\s\S]*?)<\/Encrypt>/);
    if (encryptMatch) {
      encryptedValue = (encryptMatch[1] ?? encryptMatch[2] ?? "").trim();
      if (!encryptedValue) encryptedValue = undefined;
    }
  }
  
  getWeComLogger(runtime).debug?.(`WeCom: extracted Encrypt field: ${encryptedValue ? `length=${encryptedValue.length}, first 20 chars=${encryptedValue.substring(0, 20)}...` : "NOT_FOUND"}`);

  // 验证签名（如果配置了 webhookToken）
  const msgSignature = url.searchParams.get("msg_signature");
  const timestamp = url.searchParams.get("timestamp");
  const nonce = url.searchParams.get("nonce");

  if (selectedTarget.account.webhookToken && msgSignature && timestamp && nonce) {
    // 企业微信签名验证使用 Encrypt 字段的值
    if (!encryptedValue) {
      getWeComLogger(runtime).warn("WeCom: webhookToken configured but no Encrypt field found for signature verification");
      res.statusCode = 400;
      res.end("encrypted message required");
      return true;
    }

    const isValid = verifyWeComSignature({
      token: selectedTarget.account.webhookToken,
      timestamp,
      nonce,
      encryptedMsg: encryptedValue,
      signature: msgSignature,
    });

    if (!isValid) {
      getWeComLogger(runtime).warn("WeCom webhook signature verification failed");
      res.statusCode = 401;
      res.end("unauthorized");
      return true;
    }
  }

  if (selectedTarget.account.encodingAESKey) {
    if (!encryptedValue) {
      getWeComLogger(runtime).warn("WeCom: encodingAESKey configured but no Encrypt field found in message");
      res.statusCode = 400;
      res.end("encrypted message required");
      return true;
    }
    
    const logger = getWeComLogger(runtime);
    logger.debug?.(`WeCom: attempting decryption with encodingAESKey length=${selectedTarget.account.encodingAESKey.length}, corpId=${selectedTarget.account.corpId || "not provided"}`);
    const decryptedMsg = decryptWeComMessage(
      encryptedValue,
      selectedTarget.account.encodingAESKey,
      selectedTarget.account.corpId,
      logger,
    );
    if (!decryptedMsg) {
      logger.error("WeCom message decryption failed (check logs above for details)");
      res.statusCode = 400;
      res.end("decrypt failed");
      return true;
    }

    // 解析解密后的 XML 或 JSON 消息
    try {
      // 尝试解析为 XML（企业微信通常使用 XML）
      if (decryptedMsg.trim().startsWith("<")) {
        let xmlPayload = parseWeComXML(decryptedMsg);
        if (xmlPayload) {
          // 若只解析出外层 <xml>，内层是字符串，则再解析一层（企业微信格式为 <xml><MsgType>...</MsgType>...</xml>）
          const onlyXmlKey =
            Object.keys(xmlPayload).length === 1 &&
            Object.prototype.hasOwnProperty.call(xmlPayload, "xml") &&
            typeof xmlPayload.xml === "string";
          if (onlyXmlKey && (xmlPayload.xml as string).trim().startsWith("<")) {
            const inner = parseWeComXML(xmlPayload.xml as string);
            if (inner && Object.keys(inner).length > 0) {
              xmlPayload = inner;
            }
          }
          payload = xmlPayload;
        } else {
          getWeComLogger(runtime).error("WeCom XML parse failed after decryption");
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
      getWeComLogger(runtime).error(`WeCom decrypted message parse failed: ${String(err)}`);
      res.statusCode = 400;
      res.end("parse failed");
      return true;
    }
  }
  
  // 处理消息
  selectedTarget.statusSink?.({ lastInboundAt: Date.now() });

  // 兼容 XML（PascalCase）、JSON（camelCase）及全小写键名
  const raw = payload as Record<string, unknown>;
  const msgType =
    (typeof payload.MsgType === "string" ? payload.MsgType : "") ||
    (typeof raw.msgType === "string" ? raw.msgType : "") ||
    (typeof raw.MsgType === "string" ? raw.MsgType : "");
  const fromUserName =
    (typeof payload.FromUserName === "string" ? payload.FromUserName : "") ||
    (typeof raw.fromUserName === "string" ? raw.fromUserName : "") ||
    (typeof raw.FromUserName === "string" ? raw.FromUserName : "");
  const contentStr =
    (typeof payload.Content === "string" ? payload.Content : "") ||
    (typeof raw.content === "string" ? raw.content : "") ||
    (typeof raw.Content === "string" ? raw.Content : "");
  // 全小写键名（部分接口返回）
  const msgTypeLow = typeof raw.msgtype === "string" ? raw.msgtype : "";
  const fromLow = typeof raw.fromusername === "string" ? raw.fromusername : "";
  const contentLow = typeof raw.content === "string" ? raw.content : "";
  const finalMsgType = msgType || msgTypeLow;
  const finalFrom = fromUserName || fromLow;
  const finalContent = contentStr || contentLow;
  if (finalMsgType && !payload.FromUserName && finalFrom) raw.FromUserName = finalFrom;
  if (finalContent && typeof payload.Content !== "string") raw.Content = finalContent;
  if (finalMsgType && !payload.MsgType) raw.MsgType = finalMsgType;

  const contentPreview = String(finalContent || (typeof payload.Content === "string" ? payload.Content : "") || "").substring(0, 50) || "N/A";
  getWeComLogger(runtime).info(`[wecom] Processing message: msgType=${finalMsgType}, FromUserName=${finalFrom || payload.FromUserName}, Content=${contentPreview}`);
  if (!finalMsgType) {
    getWeComLogger(runtime).debug?.(`[wecom] decrypted payload keys: ${Object.keys(payload).join(", ")}`);
  }

  if (finalMsgType === "text") {
    processWeComMessage({
      payload,
      target: selectedTarget,
    }).catch((err) => {
      selectedTarget.runtime.error?.(
        `[${selectedTarget.account.accountId}] WeCom webhook failed: ${String(err)}`,
      );
    });
  } else {
    getWeComLogger(runtime).info(`[wecom] webhook received unsupported msgType: ${finalMsgType}`);
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

  getWeComLogger(core).info(`[wecom:${account.accountId}] Webhook path registered: ${normalizedPath}`);

  return { stop };
}
