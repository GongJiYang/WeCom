import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import { loadWebMedia } from "clawdbot/plugin-sdk";

import { getAccessToken, sendMessage as sendWeComMessage, uploadMedia, type WeComFetch, type WeComSendMessageParams } from "./api.js";
import { resolveWeComAccount } from "./accounts.js";

export type WeComSendOptions = {
  accountId?: string;
  cfg?: ClawdbotConfig;
  verbose?: boolean;
  fetcher?: WeComFetch;
};

export type WeComSendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

// Access token 缓存（简单的内存缓存）
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getCachedAccessToken(
  corpId: string,
  secret: string,
  fetcher?: WeComFetch,
): Promise<string> {
  const cacheKey = `${corpId}:${secret}`;
  const cached = tokenCache.get(cacheKey);

  // 如果缓存有效（提前 5 分钟刷新），直接返回
  if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cached.token;
  }

  // 获取新的 access_token
  const tokenResult = await getAccessToken(corpId, secret, 10000, fetcher);
  
  // 更新缓存
  tokenCache.set(cacheKey, {
    token: tokenResult.access_token,
    expiresAt: tokenResult.expires_at,
  });

  return tokenResult.access_token;
}

function normalizeWeComTarget(target: string): { touser?: string; toparty?: string; totag?: string } {
  const trimmed = target.trim();
  
  // 支持格式：userid, @userid, party:partyid, tag:tagname
  if (trimmed.startsWith("party:")) {
    return { toparty: trimmed.slice(6) };
  }
  if (trimmed.startsWith("tag:")) {
    return { totag: trimmed.slice(4) };
  }
  // 移除 @ 前缀（如果有）
  const userId = trimmed.replace(/^@/, "");
  return { touser: userId };
}

export async function sendMessageWeCom(
  to: string,
  text: string,
  options: WeComSendOptions = {},
): Promise<WeComSendResult> {
  if (!to?.trim()) {
    return { ok: false, error: "No target provided" };
  }

  if (!text?.trim()) {
    return { ok: false, error: "No message text provided" };
  }

  let account;
  if (options.cfg) {
    account = resolveWeComAccount({
      cfg: options.cfg,
      accountId: options.accountId,
    });
  } else {
    return { ok: false, error: "Configuration required" };
  }

  if (!account.configured) {
    return {
      ok: false,
      error: `WeCom account "${account.accountId}" is not configured. Please configure corpId, agentId, and secret.`,
    };
  }

  try {
    // 获取 access_token
    const accessToken = await getCachedAccessToken(
      account.corpId,
      account.secret,
      options.fetcher,
    );

    // 解析目标
    const target = normalizeWeComTarget(to);

    // 构建消息参数
    const messageParams: WeComSendMessageParams = {
      ...target,
      msgtype: "text",
      agentid: account.agentId,
      text: {
        content: text.slice(0, 2048), // 企业微信文本消息限制
      },
      safe: 0, // 不加密
    };

    // 发送消息
    const result = await sendWeComMessage(accessToken, messageParams, options.fetcher);

    return {
      ok: true,
      messageId: result.msgid ?? `wecom-${Date.now()}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function sendMediaWeCom(
  to: string,
  mediaUrl: string,
  options: WeComSendOptions & { caption?: string } = {},
): Promise<WeComSendResult> {
  if (!to?.trim()) {
    return { ok: false, error: "No target provided" };
  }

  if (!mediaUrl?.trim()) {
    return { ok: false, error: "No media URL provided" };
  }

  let account;
  if (options.cfg) {
    account = resolveWeComAccount({
      cfg: options.cfg,
      accountId: options.accountId,
    });
  } else {
    return { ok: false, error: "Configuration required" };
  }

  if (!account.configured) {
    return {
      ok: false,
      error: `WeCom account "${account.accountId}" is not configured. Please configure corpId, agentId, and secret.`,
    };
  }

  try {
    // 获取 access_token
    const accessToken = await getCachedAccessToken(
      account.corpId,
      account.secret,
      options.fetcher,
    );

    // 加载媒体文件
    const maxBytes = (account.mediaMaxMb ?? 20) * 1024 * 1024;
    const media = await loadWebMedia(mediaUrl, maxBytes);

    // 确定媒体类型
    let mediaType: "image" | "voice" | "video" | "file" = "file";
    if (media.contentType) {
      if (media.contentType.startsWith("image/")) {
        mediaType = "image";
      } else if (media.contentType.startsWith("audio/") || media.contentType.startsWith("voice/")) {
        mediaType = "voice";
      } else if (media.contentType.startsWith("video/")) {
        mediaType = "video";
      }
    }

    // 上传媒体文件
    const uploadResult = await uploadMedia(
      accessToken,
      mediaType,
      media.buffer,
      media.fileName ?? "file",
      options.fetcher,
    );

    // 解析目标
    const target = normalizeWeComTarget(to);

    // 构建媒体消息参数
    const messageParams: WeComSendMessageParams = {
      ...target,
      msgtype: mediaType,
      agentid: account.agentId,
      ...(mediaType === "image" ? {
        image: {
          media_id: uploadResult.media_id,
        },
      } : mediaType === "voice" ? {
        voice: {
          media_id: uploadResult.media_id,
        },
      } : mediaType === "video" ? {
        video: {
          media_id: uploadResult.media_id,
        },
      } : {
        file: {
          media_id: uploadResult.media_id,
        },
      }),
      safe: 0,
    };

    // 如果有文本说明，先发送文本（企业微信媒体消息不支持 caption）
    if (options.caption) {
      await sendWeComMessage(accessToken, {
        ...target,
        msgtype: "text",
        agentid: account.agentId,
        text: {
          content: options.caption,
        },
        safe: 0,
      }, options.fetcher);
    }

    // 发送媒体消息
    const result = await sendWeComMessage(accessToken, messageParams, options.fetcher);

    return {
      ok: true,
      messageId: result.msgid ?? `wecom-${Date.now()}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
