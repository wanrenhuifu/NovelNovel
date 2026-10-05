/**
 * 字数统计：中文写作里的「字数」= 汉字数 + 西文词数。
 *
 * 两个已知坑，都实测过：
 *   - 全角标点（，。、《》）会被中文写作者当成「不算字」，但它们既不空白也不落在
 *     BMP 汉字区，早期的实现会把 `，` 当独立一个「词」计进去（`《长安》` 报 4 个字）。
 *   - 扩展 B 区汉字（U+20000+，如 𠀋）是**代理对**，用不含 `u` 标志的字符类匹配
 *     只会命中一个码元，50 个这样的字会被算成 1 个。
 *
 * 所以：先剥离标点与符号，再用 `u` 标志按码点统计汉字，其余部分按空白分词。
 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[\u{20000}-\u{2fa1f}]/gu;
const PUNCTUATION =
  /[\p{P}\p{S}]/gu;
/**
 * 零宽连接符（U+200D，`\p{Cf}`）与变体选择符（U+FE0F，`\p{Mn}`）既不是标点也不是符号，
 * 剥不掉就会被当成"西文词"：`👨‍👩‍👧`（一个人）报 2 个词、`❤️` 报 1 个，而单个 `😀` 报 0 个
 * ——同一个 emoji 体系里自相矛盾，字数随 emoji 虚高。组合记号（`\p{Me}`）同理。
 */
const JOINERS = /[\p{Cf}\p{Mn}\p{Me}]/gu;

export function countWords(text: string): number {
  if (!text.trim()) return 0;
  // 标点与符号先去掉：它们不构成「字」，也不该把西文词切开成两个；连接符与变体选择符一并剥掉
  const stripped = text.replace(PUNCTUATION, " ").replace(JOINERS, "");
  const cjk = (stripped.match(CJK) ?? []).length;
  const rest = stripped.replace(CJK, " ").trim();
  const words = rest ? rest.split(/\s+/).filter(Boolean).length : 0;
  return cjk + words;
}

export function uid(): string {
  return crypto.randomUUID();
}
