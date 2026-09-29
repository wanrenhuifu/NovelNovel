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

/** 参与搜索的章节最小形状（插件的章节元数据即可满足） */
export interface SearchableChapter<Id extends string | number> {
  id?: Id;
  title: string;
  content: string;
}

/** 全角 ASCII（ＡＢＣ）与全角标点（，）折成半角，让「全半角互相命中」 */
function foldWidth(text: string): string {
  return text
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ");
}

/**
 * 归一化用于**定位**：返回值必须与原串等长，否则命中位置会错位。
 * `toLowerCase()` 在少数语言（土耳其语 İ → i̇）会改变长度——那时退回原串，
 * 宁可大小写不敏感失效，也不能把摘要切错位置。
 */
function foldForSearch(text: string): string {
  const width = foldWidth(text);
  const lowered = width.toLowerCase();
  return lowered.length === text.length ? lowered : width;
}

/**
 * 全文搜索：大小写与全半角不敏感，标题与正文都搜。
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
  const q = foldForSearch(query.trim());
  if (!q) return [];
  const results: SearchMatch<NonNullable<C["id"]>>[] = [];
  for (const ch of chapters) {
    if (results.length >= maxTotal) break;
    // 标题命中：摘要取正文开头。它占正文预算里的一格（而不是在正文之外另算），
    // 这样 maxTotal=1 时正文还能拿到一条命中，而不是被标题全吃掉。
    const titleHit = foldForSearch(ch.title).includes(q);
    if (titleHit && results.length < maxTotal) {
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
    const haystack = foldForSearch(text);
    let from = 0;
    let count = titleHit ? 1 : 0;
    while (count < maxPerChapter && results.length < maxTotal) {
      const idx = haystack.indexOf(q, from);
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
