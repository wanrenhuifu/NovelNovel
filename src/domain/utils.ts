/** 统计文本字数：CJK 字符每个算一字，其余按空白分词计（章节字数/全书统计用） */
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
