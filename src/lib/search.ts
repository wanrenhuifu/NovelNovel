/** 搜索结果片段：hit 为 true 的段是命中关键词，渲染时高亮 */
export interface SearchSegment {
  text: string;
  hit: boolean;
}

export interface SearchMatch<Id extends string | number = number> {
  chapterId: Id;
  chapterTitle: string;
  /** 命中在章节正文中的字符位置（标题命中为 null） */
  pos: number | null;
  segments: SearchSegment[];
}

/** 参与搜索的章节最小形状（浏览器端 Chapter 与 dsh 插件端的章节元数据都满足） */
export interface SearchableChapter<Id extends string | number> {
  id?: Id;
  title: string;
  content: string;
}

/**
 * 全文搜索：大小写不敏感，标题与正文都搜。
 * 每章正文最多取前 maxPerChapter 处命中，总结果上限 maxTotal；
 * 章节按传入顺序（调用方保证已按 sortOrder 排序），命中按出现先后。
 */
export function searchChapters<
  C extends { id?: string | number; title: string; content: string },
>(
  chapters: C[],
  query: string,
  { maxPerChapter = 20, maxTotal = 200 } = {},
): SearchMatch<NonNullable<C["id"]>>[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: SearchMatch<NonNullable<C["id"]>>[] = [];
  for (const ch of chapters) {
    if (results.length >= maxTotal) break;
    // 标题命中：摘要取正文开头
    if (ch.title.toLowerCase().includes(q) && results.length < maxTotal) {
      const bodyStart = ch.content.slice(0, 40).replace(/\s+/g, " ").trim();
      results.push({
        chapterId: ch.id as NonNullable<C["id"]>,
        chapterTitle: ch.title,
        pos: null,
        segments: [
          { text: "标题命中 · ", hit: false },
          ...(bodyStart ? [{ text: bodyStart, hit: false }] : []),
        ],
      });
    }
    const text = ch.content;
    const lower = text.toLowerCase();
    let from = 0;
    let count = 0;
    while (count < maxPerChapter && results.length < maxTotal) {
      const idx = lower.indexOf(q, from);
      if (idx < 0) break;
      results.push({
        chapterId: ch.id as NonNullable<C["id"]>,
        chapterTitle: ch.title,
        pos: idx,
        segments: buildSegments(text, idx, q.length),
      });
      from = idx + q.length;
      count++;
    }
  }
  return results;
}

/** 命中处前后各取约 radius 字符作为摘要，换行折叠为空格 */
function buildSegments(
  text: string,
  idx: number,
  len: number,
  radius = 18,
): SearchSegment[] {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + len + radius);
  const clean = (s: string) => s.replace(/\s+/g, " ");
  const segments: SearchSegment[] = [];
  if (start > 0) segments.push({ text: "…" + clean(text.slice(start, idx)), hit: false });
  else if (idx > 0) segments.push({ text: clean(text.slice(0, idx)), hit: false });
  segments.push({ text: clean(text.slice(idx, idx + len)), hit: true });
  const tail = text.slice(idx + len, end);
  if (tail) {
    segments.push({
      text: clean(tail) + (end < text.length ? "…" : ""),
      hit: false,
    });
  }
  return segments;
}
