import type { ChatMessage, GenerateCallbacks, GenerateParams, AIProviderLike } from "./types";
import { readSSEStream, readErrorBody } from "./sse";
import { fetchWithProxyFallback } from "./proxy";
import { RetryableHttpError, isRetryableStatus, parseRetryAfter, withRetry } from "./retry";

function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "") || "https://api.anthropic.com";
}

/** SSE 内 error 事件的类型映射为等价 HTTP 状态，复用同一套重试判定 */
function anthropicErrorToStatus(type: unknown): number {
  switch (type) {
    case "rate_limit_error":
      return 429;
    case "overloaded_error":
    case "api_error":
      return 529;
    case "timeout_error":
      return 408;
    default:
      return 400;
  }
}

/**
 * Anthropic Messages API 要求 system 单独传，messages 只接受 user/assistant，
 * 且首条必须是 user。这里把连续的 assistant/user 消息按顺序透传，system 抽出。
 */
export async function streamAnthropic(
  provider: AIProviderLike,
  messages: ChatMessage[],
  params: GenerateParams,
  cb: GenerateCallbacks,
): Promise<void> {
  const url = `${normalizeBase(provider.baseUrl)}/v1/messages`;
  const systemParts: string[] = [];
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else {
      turns.push({ role: m.role, content: m.content });
    }
  }
  if (turns.length === 0 || turns[0].role !== "user") {
    turns.unshift({ role: "user", content: "请继续。" });
  }

  let emitted = false;
  await withRetry(
    async () => {
      const response = await fetchWithProxyFallback(
        url,
        {
          "Content-Type": "application/json",
          "x-api-key": provider.apiKey,
          "anthropic-version": "2023-06-01",
          // 允许浏览器直连（Anthropic 官方 CORS 支持）
          "anthropic-dangerous-direct-browser-access": "true",
        },
        {
          model: provider.modelId,
          system: systemParts.join("\n\n") || undefined,
          messages: turns,
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
          retryable: isRetryableStatus(response.status),
        });
      }

      await readSSEStream(response, (data) => {
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data);
          if (json?.type === "content_block_delta") {
            const text = json?.delta?.text;
            if (typeof text === "string" && text) {
              emitted = true;
              cb.onToken(text);
            }
          } else if (json?.type === "error") {
            const status = anthropicErrorToStatus(json?.error?.type);
            throw new RetryableHttpError({
              message: json?.error?.message ?? "Anthropic 流式错误",
              status,
              retryable: isRetryableStatus(status),
            });
          }
        } catch (e) {
          if (e instanceof SyntaxError) return;
          throw e;
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

export async function listAnthropicModels(
  provider: AIProviderLike,
): Promise<string[]> {
  const url = `${normalizeBase(provider.baseUrl)}/v1/models`;
  const response = await fetch(url, {
    headers: {
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
    },
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
