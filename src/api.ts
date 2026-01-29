/**
 * 企业微信 API 客户端
 * @see https://developer.work.weixin.qq.com/document/path/90605
 */

import { Buffer } from "node:buffer";

const WECOM_API_BASE = "https://qyapi.weixin.qq.com";

export type WeComFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type WeComApiResponse<T = unknown> = {
  errcode: number;
  errmsg: string;
  access_token?: string;
  expires_in?: number;
} & T;

export type WeComAccessToken = {
  access_token: string;
  expires_in: number;
  expires_at: number;
};

export type WeComAgentInfo = {
  agentid: number;
  name: string;
  square_logo_url?: string;
  description?: string;
};

export type WeComUserInfo = {
  userid: string;
  name: string;
  mobile?: string;
  email?: string;
  avatar?: string;
};

export class WeComApiError extends Error {
  constructor(
    message: string,
    public readonly errorCode: number,
    public readonly errorMsg: string,
  ) {
    super(message);
    this.name = "WeComApiError";
  }
}

/**
 * 获取 access_token
 * @see https://developer.work.weixin.qq.com/document/path/90605
 */
export async function getAccessToken(
  corpId: string,
  secret: string,
  timeoutMs = 10000,
  fetcher?: WeComFetch,
): Promise<WeComAccessToken> {
  if (!corpId?.trim() || !secret?.trim()) {
    throw new WeComApiError("corpId and secret are required", -1, "参数错误");
  }

  const url = `${WECOM_API_BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId.trim())}&corpsecret=${encodeURIComponent(secret.trim())}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const fetchFn = fetcher ?? fetch;

  try {
    const response = await fetchFn(url, {
      method: "GET",
      signal: controller.signal,
    });

    const data = (await response.json()) as WeComApiResponse;

    if (data.errcode !== 0) {
      throw new WeComApiError(
        `获取 access_token 失败: ${data.errmsg}`,
        data.errcode,
        data.errmsg,
      );
    }

    if (!data.access_token) {
      throw new WeComApiError("access_token 为空", -1, "响应数据错误");
    }

    const expiresIn = data.expires_in ?? 7200;
    return {
      access_token: data.access_token,
      expires_in: expiresIn,
      expires_at: Date.now() + expiresIn * 1000,
    };
  } catch (err) {
    if (err instanceof WeComApiError) {
      throw err;
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new WeComApiError(`请求超时 (${timeoutMs}ms)`, -1, "请求超时");
    }
    throw new WeComApiError(
      err instanceof Error ? err.message : String(err),
      -1,
      "网络错误",
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 调用企业微信 API
 */
export async function callWeComApi<T = unknown>(
  method: string,
  accessToken: string,
  body?: Record<string, unknown>,
  options?: { timeoutMs?: number; fetch?: WeComFetch },
): Promise<T> {
  const url = `${WECOM_API_BASE}/cgi-bin/${method}?access_token=${encodeURIComponent(accessToken)}`;
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 10000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const fetcher = options?.fetch ?? fetch;

  try {
    const response = await fetcher(url, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const data = (await response.json()) as WeComApiResponse<T>;

    if (data.errcode !== 0) {
      throw new WeComApiError(
        `API 调用失败: ${data.errmsg}`,
        data.errcode,
        data.errmsg,
      );
    }

    // 移除 errcode/errmsg/access_token 等字段，返回实际数据
    const { errcode: _errcode, errmsg: _errmsg, access_token: _token, expires_in: _expires, ...result } = data;
    return result as T;
  } catch (err) {
    if (err instanceof WeComApiError) {
      throw err;
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new WeComApiError(`请求超时 (${timeoutMs}ms)`, -1, "请求超时");
    }
    throw new WeComApiError(
      err instanceof Error ? err.message : String(err),
      -1,
      "网络错误",
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 获取应用信息
 * @see https://developer.work.weixin.qq.com/document/path/90227
 */
export async function getAgentInfo(
  accessToken: string,
  agentId: string,
  fetcher?: WeComFetch,
): Promise<WeComAgentInfo> {
  return callWeComApi<WeComAgentInfo>(
    "agent/get",
    accessToken,
    { agentid: agentId },
    { fetch: fetcher },
  );
}

/**
 * 获取用户信息
 * @see https://developer.work.weixin.qq.com/document/path/90196
 */
export async function getUserInfo(
  accessToken: string,
  userId: string,
  fetcher?: WeComFetch,
): Promise<WeComUserInfo> {
  return callWeComApi<WeComUserInfo>(
    "user/get",
    accessToken,
    { userid: userId },
    { fetch: fetcher },
  );
}

/**
 * 发送应用消息
 * @see https://developer.work.weixin.qq.com/document/path/90236
 */
export type WeComSendMessageParams = {
  touser?: string;
  toparty?: string;
  totag?: string;
  msgtype: "text" | "image" | "voice" | "video" | "file" | "textcard" | "news" | "mpnews";
  agentid: string;
  text?: {
    content: string;
  };
  image?: {
    media_id: string;
  };
  voice?: {
    media_id: string;
  };
  video?: {
    media_id: string;
    title?: string;
    description?: string;
  };
  file?: {
    media_id: string;
  };
  safe?: number;
  enable_id_trans?: number;
  enable_duplicate_check?: number;
  duplicate_check_interval?: number;
};

export type WeComSendMessageResult = {
  invaliduser?: string;
  invalidparty?: string;
  invalidtag?: string;
  msgid?: string;
  response_code?: string;
};

export async function sendMessage(
  accessToken: string,
  params: WeComSendMessageParams,
  fetcher?: WeComFetch,
): Promise<WeComSendMessageResult> {
  return callWeComApi<WeComSendMessageResult>(
    "message/send",
    accessToken,
    params,
    { fetch: fetcher },
  );
}

/**
 * 上传媒体文件
 * @see https://developer.work.weixin.qq.com/document/path/90253
 */
export type WeComUploadMediaResult = {
  type: string;
  media_id: string;
  created_at: number;
};

export async function uploadMedia(
  accessToken: string,
  mediaType: "image" | "voice" | "video" | "file",
  buffer: Buffer,
  fileName: string,
  fetcher?: WeComFetch,
): Promise<WeComUploadMediaResult> {
  const url = `${WECOM_API_BASE}/cgi-bin/media/upload?access_token=${encodeURIComponent(accessToken)}&type=${encodeURIComponent(mediaType)}`;
  const fetchFn = fetcher ?? fetch;

  // 构建 multipart/form-data（手动构建以兼容 Node.js 环境）
  const boundary = `----WebKitFormBoundary${Math.random().toString(36).substring(2)}`;
  const parts: Buffer[] = [];

  // 添加 media 字段
  parts.push(Buffer.from(`--${boundary}\r\n`));
  parts.push(
    Buffer.from(
      `Content-Disposition: form-data; name="media"; filename="${fileName}"\r\n`,
    ),
  );
  parts.push(Buffer.from(`Content-Type: application/octet-stream\r\n\r\n`));
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  const data = (await response.json()) as WeComApiResponse<WeComUploadMediaResult>;

  if (data.errcode !== 0) {
    throw new WeComApiError(
      `上传媒体失败: ${data.errmsg}`,
      data.errcode,
      data.errmsg,
    );
  }

  const { errcode: _errcode, errmsg: _errmsg, access_token: _token, expires_in: _expires, ...result } = data;
  return result as WeComUploadMediaResult;
}
