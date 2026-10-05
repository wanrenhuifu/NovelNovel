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
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable === true) return;
      // 焦点不在本面板内：不响应（页面别处可能正要滚动或用 j/k）
      if (target !== null && !root.contains(target)) return;

      const step =
        event.key === "ArrowDown" || event.key === "j" ? 1 : event.key === "ArrowUp" || event.key === "k" ? -1 : 0;
      if (step === 0) return;

      const { chapters: list, currentId: current, onSelect: select } = latest.current;
      if (list.length === 0) return;

      const found = list.findIndex((c) => c.id === current);
      // 未选中时（刚打开面板、刚切完作品）：按方向键应当落在**第 1 章**。
      // 这里用 found（-1）而不是 0 作为基准：step=+1 得 0，step=-1 得 -2（越界不动）。
      const next = found + step;
      if (next < 0 || next >= list.length) return;

      const target0 = list[next];
      if (target0 === undefined) return;
      event.preventDefault();
      select(target0.id);
    };

    // 挂在容器上（而不是 window）：只有面板内的按键才会冒泡到这里
    root.addEventListener("keydown", handler);
    return () => {
      root.removeEventListener("keydown", handler);
    };
  }, [root]);

  return { rootRef: setRoot };
}
