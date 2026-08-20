import type { ChatMessage, GenerateCallbacks, GenerateParams, AIProviderLike } from "./types";
import { streamOpenAI, listOpenAIModels } from "./openai";
import { streamAnthropic, listAnthropicModels } from "./anthropic";

export type { ChatMessage, GenerateParams } from "./types";

/** 统一入口：按 provider 类型分发到对应实现，流式输出经 cb.onToken 回调 */
export async function generateStream(
  provider: AIProviderLike,
  messages: ChatMessage[],
  params: GenerateParams,
  cb: GenerateCallbacks,
): Promise<void> {
  if (provider.type === "anthropic") {
    await streamAnthropic(provider, messages, params, cb);
  } else {
    await streamOpenAI(provider, messages, params, cb);
  }
}

export async function listModels(provider: AIProviderLike): Promise<string[]> {
  return provider.type === "anthropic"
    ? listAnthropicModels(provider)
    : listOpenAIModels(provider);
}
