/**
 * 章节键盘导航：↑/↓ 与 j/k 切换上一章/下一章，Home/End 跳到首尾。
 *
 * 只读面板也需要手感——读小说时手不该离开键盘。两个约束：
 * - 在输入框里按键一律不拦（用户可能在别处打字）；
 * - 到达边界不循环（读长篇小说时"从头开始"是意外，不是方便）。
 */
import { useEffect } from "react";

interface ChapterRef {
  id: string;
}

export function useChapterKeys(chapters: readonly ChapterRef[], onSelect: (id: string) => void): void {
  useEffect(() => {
    if (chapters.length === 0) return undefined;

    const handler = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable === true) return;

      const key = event.key;
      const step = key === "ArrowDown" || key === "j" ? 1 : key === "ArrowUp" || key === "k" ? -1 : 0;
      const isHome = key === "Home";
      const isEnd = key === "End";
      if (step === 0 && !isHome && !isEnd) return;

      // 以"当前选中的章节"为基准，而不是内部记录的位置，避免与实际显示脱节
      const currentIndex = chapters.findIndex((c) => c.id === currentChapterId());
      const from = currentIndex >= 0 ? currentIndex : 0;
      const next = isHome ? 0 : isEnd ? chapters.length - 1 : from + step;
      if (next < 0 || next >= chapters.length || next === currentIndex) return;

      const target0 = chapters[next];
      if (target0 === undefined) return;
      event.preventDefault();
      onSelect(target0.id);
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [chapters, onSelect]);
}

/** 当前选中章节由 DOM 上的 data-selected 标记读出——不必再引一份状态 */
function currentChapterId(): string {
  const selected = document.querySelector<HTMLElement>('.nnv-row[data-selected="true"]');
  return selected?.dataset.chapterId ?? "";
}
