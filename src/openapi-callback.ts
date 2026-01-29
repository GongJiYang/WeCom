import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { getWeComRuntime } from "./runtime.js";
import { resolveWeComAccount } from "./accounts.js";

/**
 * 解密企业微信加密消息（AES-256-CBC）
 * 与 monitor.ts 中的 decryptWeComMessage 逻辑相同
 */
function decryptWeComMessage(
  encryptedMsg: string,
  encodingAESKey: string,
  corpId?: string,
): string | null {
  try {
    // 1. Base64 解码 encodingAESKey（43 位 -> 32 字节）
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

    // 如果提供了 corpId，验证 receiveid 是否匹配
    if (corpId && receiveid && receiveid !== corpId && receiveid !== `$${corpId}`) {
      return null;
    }

    return msg;
  } catch {
    return null;
  }
}

/**
 * 验证企业微信 webhook 签名
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

/**
 * 处理企业微信「API 接收消息」的回调地址验证
 * 企业微信的 API 接收消息回调验证流程与普通接收消息相同：
 * 1. 验证签名（msg_signature）
 * 2. 解密 echostr
 * 3. 返回解密后的明文
 */
export async function handleWeComOpenApiCallback(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    
    // 企业微信验证请求（GET）
    if (req.method === "GET") {
      const echostr = url.searchParams.get("echostr");
      const msgSignature = url.searchParams.get("msg_signature");
      const timestamp = url.searchParams.get("timestamp");
      const nonce = url.searchParams.get("nonce");

      // 如果没有 echostr，返回 ok（兼容性处理）
      if (!echostr) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
        return;
      }

      // 从配置中读取 account 信息
      let account: ReturnType<typeof resolveWeComAccount> | null = null;
      try {
        const config = getWeComRuntime().config.loadConfig();
        account = resolveWeComAccount({ cfg: config });
      } catch {
        // 配置读取失败，返回错误
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ errcode: -1, errmsg: "config error" }));
        return;
      }

      if (!account.configured || !account.webhookToken || !account.encodingAESKey) {
        // 配置不完整，返回错误
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ errcode: -1, errmsg: "not configured" }));
        return;
      }

      // 验证签名
      if (msgSignature && timestamp && nonce) {
        const isValid = verifyWeComSignature({
          token: account.webhookToken,
          timestamp,
          nonce,
          encryptedMsg: echostr,
          signature: msgSignature,
        });

        if (!isValid) {
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ errcode: -1, errmsg: "signature invalid" }));
          return;
        }
      }

      // 解密 echostr
      const decryptedEchostr = decryptWeComMessage(
        echostr,
        account.encodingAESKey,
        account.corpId,
      );

      if (!decryptedEchostr) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ errcode: -1, errmsg: "decrypt failed" }));
        return;
      }

      // 返回解密后的明文（不能加引号、不能带 BOM 头、不能带换行符）
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(decryptedEchostr);
      return;
    }

    // POST 请求（实际的消息回调）
    // 读取请求体
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => resolve());
      req.on("error", () => resolve());
    });

    // 对于 POST 请求，返回成功响应（实际业务处理在 webhook handler 中）
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ errcode: -1, errmsg: String(err) }));
  }
}
