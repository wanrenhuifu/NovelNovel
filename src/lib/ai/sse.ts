/** 逐行解析 SSE 流，每个 data 事件回调一次 */
export async function readSSEStream(
  response: Response,
  onData: (data: string) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("响应不包含可读流");
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (trimmed.startsWith("data:")) {
        onData(trimmed.slice(5).trim());
      }
    }
  }
  if (buffer.trim().startsWith("data:")) {
    onData(buffer.trim().slice(5).trim());
  }
}

export async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      return (
        json?.error?.message ?? json?.message ?? json?.error ?? text.slice(0, 400)
      );
    } catch {
      return text.slice(0, 400);
    }
  } catch {
    return response.statusText;
  }
}
