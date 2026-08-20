/**
 * AI 请求失败自动重试。
 * 约束：仅在首个 token 输出之前重试（已输出再重试会产生重复内容），
 * 该判断由调用方保证——provider 里 token 输出后的错误必须包成
 * RetryableHttpError.retryable=false 再抛。
 */

/** 可重试错误：HTTP 状态类失败或流在出字前中断 */
export class RetryableHttpError extends Error {
  readonly status: number;
  /** 服务端 Retry-After 头（秒），可能为 null */
  readonly retryAfterSec: number | null;
  readonly retryable: boolean;

  constructor(opts: {
    message: string;
    status: number;
    retryAfterSec?: number | null;
    retryable?: boolean;
  }) {
    super(opts.message);
    this.name = "RetryableHttpError";
    this.status = opts.status;
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.retryable = opts.retryable ?? true;
  }
}

/** 网关/过载类状态码才值得重试；401/403/400/404 重试无意义。529 为 Anthropic 过载 */
export function isRetryableStatus(status: number): boolean {
  return (
    status === 408 || status === 429 || status === 529 || (status >= 500 && status <= 504)
  );
}

/**
 * 解析 Retry-After 头：支持秒数与 HTTP-date 两种格式。
 * 非法或已过期返回 null；上限 60 秒防止过长等待。
 */
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds), 60);
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const delta = (date - Date.now()) / 1000;
    if (delta <= 0) return null;
    return Math.min(Math.ceil(delta), 60);
  }
  return null;
}

/**
 * 指数退避 + 抖动；有 Retry-After 时优先采用。
 * attempt 从 0 开始：1s → 2s → 4s…，封顶 8s（±25% 抖动）。
 */
export function backoffMs(attempt: number, retryAfterSec?: number | null): number {
  if (retryAfterSec != null && retryAfterSec > 0) return retryAfterSec * 1000;
  const base = Math.min(1000 * 2 ** attempt, 8000);
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(base * jitter);
}

export interface RetryOptions {
  /** 失败后的额外重试次数，默认 2（即总共最多请求 3 次） */
  maxRetries?: number;
  signal?: AbortSignal;
  /** 即将重试时回调（attempt 从 1 开始） */
  onRetry?: (info: { attempt: number; waitMs: number; message: string }) => void;
  /** 捕获错误后再次确认是否允许重试（如已输出 token 则返回 false） */
  canRetry?: () => boolean;
  /** 自定义退避时长计算（默认指数退避），测试注入短等待用 */
  backoff?: (attempt: number, retryAfterSec: number | null) => number;
}

/** 可被 AbortSignal 打断的等待；等待中被中止则抛 AbortError */
export function interruptibleDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) {
      return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 包装一次流式请求的完整尝试（含读流），按规则自动重试。
 * AbortError 直接透传，不计入重试。
 */
export async function withRetry(
  attempt: (attemptIndex: number) => Promise<void>,
  opts: RetryOptions = {},
): Promise<void> {
  const maxRetries = opts.maxRetries ?? 2;
  for (let i = 0; ; i++) {
    try {
      await attempt(i);
      return;
    } catch (e) {
      const aborted =
        opts.signal?.aborted || (e instanceof DOMException && e.name === "AbortError");
      if (aborted) throw e;
      const retryable =
        (e instanceof RetryableHttpError
          ? e.retryable
          : e instanceof TypeError) && // 网络层错误（出字前的连接中断）
        (opts.canRetry?.() ?? true);
      if (!retryable || i >= maxRetries) throw e;
      const retryAfterSec = e instanceof RetryableHttpError ? e.retryAfterSec : null;
      const waitMs = (opts.backoff ?? backoffMs)(i, retryAfterSec);
      opts.onRetry?.({
        attempt: i + 1,
        waitMs,
        message: e instanceof Error ? e.message : String(e),
      });
      await interruptibleDelay(waitMs, opts.signal);
    }
  }
}
