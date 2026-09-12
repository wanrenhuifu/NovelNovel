/**
 * 计算拖拽后的章节顺序。
 * 纯函数：输入当前章节数组（按 sortOrder 升序）+ 被拖拽 id + 目标 id + 落点（before/after），
 * 返回按新顺序排列的章节数组（sortOrder 重写为 0..n-1，避免冲突）。
 * 任何 id 不存在或 dragId === targetId 时返回 null（调用方视为无操作）。
 * id 泛化：本插件用字符串 id，同时兼容 number 主键，两端口径一致。
 */
export function computeReorder<T extends { id?: string | number; sortOrder: number }>(
  chapters: T[],
  dragId: NonNullable<T["id"]>,
  targetId: NonNullable<T["id"]>,
  position: "before" | "after",
): T[] | null {
  if (dragId === targetId) return null;
  // 防御性排序：调用方应已按 sortOrder 排好，这里兜底避免外部乱序导致结果错乱
  const sorted = [...chapters].sort((a, b) => a.sortOrder - b.sortOrder);
  const dragIdx = sorted.findIndex((c) => c.id === dragId);
  const targetIdx = sorted.findIndex((c) => c.id === targetId);
  if (dragIdx < 0 || targetIdx < 0) return null;

  const [dragged] = sorted.splice(dragIdx, 1);
  // splice 后目标索引可能偏移，重新查找
  const newTargetIdx = sorted.findIndex((c) => c.id === targetId);
  const insertAt = position === "before" ? newTargetIdx : newTargetIdx + 1;
  sorted.splice(insertAt, 0, dragged);

  return sorted.map((c, i) => ({ ...c, sortOrder: i }));
}
