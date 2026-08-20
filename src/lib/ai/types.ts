export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateParams {
  temperature: number;
  maxTokens: number;
}

export interface GenerateCallbacks {
  onToken: (token: string) => void;
  signal?: AbortSignal;
  /** 请求失败即将自动重试时回调 */
  onRetry?: (info: { attempt: number; waitMs: number; message: string }) => void;
}

export interface AIProviderLike {
  type: "openai" | "anthropic";
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

/** 拉取 provider 可用模型列表 */
export type ListModelsFn = (provider: AIProviderLike) => Promise<string[]>;
