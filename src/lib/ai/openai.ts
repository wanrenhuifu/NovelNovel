import type { ChatMessage, GenerateCallbacks, GenerateParams, AIProviderLike } from "./types";
import { readSSEStream, readErrorBody } from "./sse";
import { contentToString } from "../utils";
import { fetchWithProxyFallback } from "./proxy";
import { RetryableHttpError, isRetryableStatus, parseRetryAfter, withRetry } from "./retry";

function normalizeBase(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/+$/, "");
  if (!/\/v\d+$/.test(base)) base += "/v1";
  return base;
}

export async function streamOpenAI(
  provider: AIProviderLike,
  messages: ChatMessage[],
  params: GenerateParams,
  cb: GenerateCallbacks,
): Promise<void> {
  const url = `${normalizeBase(provider.baseUrl)}/chat/completions`;
  let emitted = false;
  const onToken = (token: string) => {
    emitted = true;
    cb.onToken(token);
  };

  await withRetry(
    async () => {
      const response = await fetchWithProxyFallback(
        url,
        {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        {
          model: provider.modelId,
          messages,
          temperature: params.temperature,
          max_tokens: params.maxTokens,
          stream: true,
        },
        cb.signal,
      );

      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw new RetryableHttpError({
          message: `请求失败 (${response.status}): ${detail}`,
          status: response.status,
          retryAfterSec: parseRetryAfter(response.headers.get("Retry-After")),
          // 非可重试状态码（401/403/400…）直接上抛
          retryable: isRetryableStatus(response.status),
        });
      }

      await readSSEStream(response, (data) => {
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data);
          const delta = json?.choices?.[0]?.delta;
          const token = contentToString(delta?.content);
          if (token) onToken(token);
        } catch {
          // 忽略无法解析的行
        }
      });
    },
    { signal: cb.signal, onRetry: cb.onRetry, canRetry: () => !emitted },
  ).catch((e) => {
    // 出字后流中断不能重试（重发会重复内容），还原为可读错误
    if (emitted) {
      if (e instanceof RetryableHttpError) throw new Error(e.message);
      if (e instanceof TypeError) throw new Error("输出过程中网络连接中断，可重新生成");
    }
    throw e;
  });
}

export async function listOpenAIModels(
  provider: AIProviderLike,
): Promise<string[]> {
  const url = `${normalizeBase(provider.baseUrl)}/models`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${provider.apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`获取模型失败 (${response.status}): ${await readErrorBody(response)}`);
  }
  const json = await response.json();
  const items = Array.isArray(json?.data) ? json.data : [];
  return items
    .map((m: { id?: string }) => m.id)
    .filter((id: unknown): id is string => typeof id === "string")
    .sort();
}
