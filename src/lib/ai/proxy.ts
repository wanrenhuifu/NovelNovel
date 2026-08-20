/** 本地代理地址：npm run proxy 启动 */
export const PROXY_BASE = "http://localhost:8788";

/**
 * 经本地代理转发一次请求。
 * @param url 真实目标 URL（代理在服务端请求它，不受浏览器 CORS 限制）
 */
export async function fetchViaProxy(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${PROXY_BASE}/proxy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, headers, body }),
    signal,
  });
}

/**
 * 先浏览器直连；若遭遇网络/CORS 级失败（fetch 抛 TypeError），
 * 自动回退到本地代理。用户主动 abort 不触发回退。
 */
export async function fetchWithProxyFallback(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    if (signal?.aborted) throw e;
  }
  try {
    return await fetchViaProxy(url, headers, body, signal);
  } catch (proxyErr) {
    if (proxyErr instanceof DOMException && proxyErr.name === "AbortError") {
      throw proxyErr;
    }
    throw new Error(
      "浏览器直连失败（疑似 CORS 限制），且本地代理不可达。" +
        "如需代理，请在项目目录运行 `npm run proxy` 后重试。",
    );
  }
}
