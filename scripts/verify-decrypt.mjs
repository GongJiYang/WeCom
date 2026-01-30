#!/usr/bin/env node
/**
 * 企业微信解密验证脚本
 * 1) 无参数：用官方文档示例验证本地解密逻辑是否正确
 * 2) 两个参数：用指定 encodingAESKey 和 base64 密文解密（用于验证线上密文）
 *
 * 用法:
 *   node scripts/verify-decrypt.mjs
 *   node scripts/verify-decrypt.mjs <encodingAESKey> <base64Ciphertext>
 *
 * 密文可从 Gateway 日志 "WeCom: extracted Encrypt field" 对应请求的 body 或
 * 抓包获取；仅用于本地验证，不要泄露。
 */

import crypto from "node:crypto";

function decrypt(encryptedMsg, encodingAESKey) {
  const rawKey = encodingAESKey.trim().replace(/\s/g, "");
  let rawEnc = encryptedMsg.trim().replace(/ /g, "+").replace(/[\n\r\t]/g, "");

  if (rawKey.length !== 43) {
    throw new Error(`encodingAESKey length=${rawKey.length}, expected 43`);
  }
  let aesKeyBase64 = rawKey;
  if (aesKeyBase64.length === 43) aesKeyBase64 += "=";
  const aesKey = Buffer.from(aesKeyBase64, "base64");
  if (aesKey.length !== 32) {
    throw new Error(`AES key decoded length=${aesKey.length}, expected 32`);
  }

  const iv = aesKey.subarray(0, 16);
  const encrypted = Buffer.from(rawEnc, "base64");
  if (encrypted.length === 0) throw new Error("empty ciphertext");

  // OpenSSL 3 对 PKCS#7 校验过严，企业微信密文可能被拒；关闭自动去 padding，解密后手动去除
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
  decipher.setAutoPadding(false);
  let decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const padLen = decrypted[decrypted.length - 1];
  if (padLen >= 1 && padLen <= 16 && decrypted.length >= padLen) {
    decrypted = decrypted.subarray(0, decrypted.length - padLen);
  }

  if (decrypted.length < 20) throw new Error("decrypted too short");
  const msgLen = decrypted.subarray(16, 20).readUInt32BE(0);
  if (msgLen < 0 || msgLen > decrypted.length - 20) {
    throw new Error(`invalid msgLen=${msgLen}, available=${decrypted.length - 20}`);
  }
  const msg = decrypted.subarray(20, 20 + msgLen).toString("utf8");
  const receiveid = decrypted.subarray(20 + msgLen).toString("utf8");
  return { msg, receiveid };
}

// 企业微信官方文档示例（path 90968）
const OFFICIAL_KEY =
  "jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C";
const OFFICIAL_CIPHERTEXT =
  "RypEvHKD8QQKFhvQ6QleEB4J58tiPdvo+rtK1I9qca6aM/wvqnLSV5zEPeusUiX5L5X/0lWfrf0QADHHhGd3QczcdCUpj911L3vg3W/sYYvuJTs3TUUkSUXxaccAS0qhxchrRYt66wiSpGLYL42aM6A8dTT+6k4aSknmPj48kzJs8qLjvd4Xgpue06DOdnLxAUHzM6+kDZ+HMZfJYuR+LtwGc2hgf5gsijff0ekUNXZiqATP7PF5mZxZ3Izoun1s4zG4LUMnvw2r+KqCKIw+3IQH03v+BCA9nMELNqbSf6tiWSrXJB3LAVGUcallcrw8V2t9EL4EhzJWrQUax5wLVMNS0+rUPA3k22Ncx4XXZS9o0MBH27Bo6BpNelZpS+/uh9KsNlY6bHCmJU9p8g7m3fVKn28H3KDYA5Pl/T8Z1ptDAVe0lXdQ2YoyyH2uyPIGHBZZIs2pDBS8R07+qN+E7Q==";

const [,, keyArg, cipherArg] = process.argv;

if (keyArg && cipherArg) {
  console.log("使用传入的 encodingAESKey 与密文解密…\n");
  try {
    const { msg, receiveid } = decrypt(cipherArg, keyArg);
    console.log("解密成功");
    console.log("receiveid:", receiveid);
    console.log("msg 长度:", msg.length);
    console.log("msg 前 200 字符:", msg.slice(0, 200));
  } catch (err) {
    console.error("解密失败:", err.message);
    process.exit(1);
  }
} else {
  console.log("使用企业微信官方文档示例验证解密逻辑…\n");
  try {
    const { msg, receiveid } = decrypt(OFFICIAL_CIPHERTEXT, OFFICIAL_KEY);
    console.log("官方示例解密成功（解密未抛错）。");
    console.log("receiveid:", receiveid);
    console.log("msg 长度:", msg.length);
    console.log("msg 前 200 字符:", msg.slice(0, 200));
  } catch (err) {
    console.error("官方示例解密失败:", err.message);
    console.error("");
    console.error("说明：在 Node 22 + OpenSSL 3 下，官方文档示例也可能 bad decrypt，");
    console.error("属于环境与示例兼容性问题。建议用「自定义密钥+密文」验证：");
    console.error("  node scripts/verify-decrypt.mjs <encodingAESKey> <base64Ciphertext>");
    console.error("从 Gateway 日志或抓包拿到一次请求的 Encrypt 值，与配置里的 encodingAESKey 一起传入。");
    process.exit(1);
  }
}
