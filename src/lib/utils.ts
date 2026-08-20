/** 统计文本字数：CJK 字符每个算一字，其余按空白分词计 */
export function countWords(text: string): number {
  if (!text.trim()) return 0;
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g) ?? [])
    .length;
  const rest = text
    .replace(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g, " ")
    .trim();
  const words = rest ? rest.split(/\s+/).length : 0;
  return cjk + words;
}

export function uid(): string {
  return crypto.randomUUID();
}

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 拼接多个模型可能返回的 content 形态 */
export function contentToString(
  content:
    | string
    | null
    | undefined
    | Array<{ type?: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part?.type === "text" ? (part.text ?? "") : ""))
      .join("");
  }
  return "";
}
