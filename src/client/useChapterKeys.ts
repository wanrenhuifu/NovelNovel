/**
 * 章节键盘导航：↑/↓ 与 j/k 切换上一章/下一章。
 *
 * 三个刻意的约束：
 * - 输入框/可编辑区里一律不拦（用户可能在别处打字）；
 * - 只处理方向键与 j/k，**不碰 Home/End**（那两个键在别处有既定含义，抢了只会让人恼火）；
 * - 到边界不循环（读长篇小说时"从头开始"是意外，不是方便）。
 *
 * 当前章由**状态**传入，不去 DOM 里反查——反查在面板未打开、
 * 或同页有多个实例时会读到空或读错。
 */
import { useEffect, useRef, useState } from "react";

interface ChapterRef {
  id: string;
}

/**
 * 按键 → 步进方向；不是导航键时返回 0。
 *
 * 只认方向键与 j/k：**不碰 Home/End**（那两个键在别处有既定含义，抢了会让人恼火），
 * 带修饰键的组合一律放行给浏览器/系统。
 */
export function stepForKey(event: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): number {
  if (event.metaKey === true || event.ctrlKey === true || event.altKey === true || event.shiftKey === true) {
    return 0;
  }
  if (event.key === "ArrowDown" || event.key === "j") return 1;
  if (event.key === "ArrowUp" || event.key === "k") return -1;
  return 0;
}

/**
 * 挑出要跳到的章节 id；不该动时返回 null。
 *
 * **未选中时（`currentId` 为 null 或不在列表里）按 ↓ 要落在第 1 章**——这里用
 * `findIndex` 的 -1 当基准而不是 0：step=+1 得 0（第 1 章），step=-1 得 -2（越界不动）。
 * 早先的写法把 -1 归到 0，于是第一次按 ↓ 跳到**第 2 章**、第 1 章永远按不到。
 * 到边界也不循环（读长篇小说时"从头开始"是意外，不是方便）。
 */
export function nextChapterId(
  chapters: readonly ChapterRef[],
  currentId: string | null,
  step: number,
): string | null {
  if (step === 0 || chapters.length === 0) return null;
  const found = chapters.findIndex((chapter) => chapter.id === currentId);
  const next = found + step;
  if (next < 0 || next >= chapters.length) return null;
  return chapters[next]?.id ?? null;
}

export function useChapterKeys(
  chapters: readonly ChapterRef[],
  currentId: string | null,
  onSelect: (id: string) => void,
): { rootRef: (node: HTMLElement | null) => void } {
  // 用 ref 持有最新值：effect 因此不必依赖 chapters/currentId——
  // 列表每次渲染都是新数组引用，直接进依赖会反复解绑重绑
  const latest = useRef({ chapters, currentId, onSelect });
  latest.current = { chapters, currentId, onSelect };

  // 面板根节点：按键只在这个子树里才处理。挂在 window 上会抢走
  // 页面其他地方的 ↑/↓（连滚动都没了）和裸 j/k。
  const [root, setRoot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (root === null) return undefined;

    const handler = (event: KeyboardEvent): void => {
      const step = stepForKey(event);
      if (step === 0) return;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable === true) return;
      // 焦点不在本面板内：不响应（页面别处可能正要滚动或用 j/k）
      if (target !== null && !root.contains(target)) return;

      const { chapters: list, currentId: current, onSelect: select } = latest.current;
      const next = nextChapterId(list, current, step);
      if (next === null) return;
      event.preventDefault();
      select(next);
    };

    // 挂在容器上（而不是 window）：只有面板内的按键才会冒泡到这里
    root.addEventListener("keydown", handler);
    return () => {
      root.removeEventListener("keydown", handler);
    };
  }, [root]);

  return { rootRef: setRoot };
}
