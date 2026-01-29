import { getAccessToken, getAgentInfo, WeComApiError, type WeComAgentInfo, type WeComFetch } from "./api.js";

export type WeComProbeResult = {
  ok: boolean;
  agent?: WeComAgentInfo;
  error?: string;
  elapsedMs: number;
};

export async function probeWeCom(
  corpId: string,
  agentId: string,
  secret: string,
  timeoutMs = 10000,
  fetcher?: WeComFetch,
): Promise<WeComProbeResult> {
  if (!corpId?.trim() || !agentId?.trim() || !secret?.trim()) {
    return {
      ok: false,
      error: "corpId, agentId, and secret are required",
      elapsedMs: 0,
    };
  }

  const startTime = Date.now();

  try {
    // 1. 获取 access_token
    const tokenResult = await getAccessToken(
      corpId.trim(),
      secret.trim(),
      timeoutMs,
      fetcher,
    );

    // 2. 验证应用信息
    const agentInfo = await getAgentInfo(
      tokenResult.access_token,
      agentId.trim(),
      fetcher,
    );

    const elapsedMs = Date.now() - startTime;
    return { ok: true, agent: agentInfo, elapsedMs };
  } catch (err) {
    const elapsedMs = Date.now() - startTime;

    if (err instanceof WeComApiError) {
      return {
        ok: false,
        error: `${err.errorMsg} (errcode: ${err.errorCode})`,
        elapsedMs,
      };
    }

    if (err instanceof Error) {
      if (err.name === "AbortError") {
        return {
          ok: false,
          error: `请求超时 (${timeoutMs}ms)`,
          elapsedMs,
        };
      }
      return { ok: false, error: err.message, elapsedMs };
    }

    return { ok: false, error: String(err), elapsedMs };
  }
}
