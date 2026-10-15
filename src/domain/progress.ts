/**
 * 「已写 / 目标」字数的展示口径（第 3 件新功能：全书目标字数）。
 *
 * 抽成纯函数是为了两件事：
 * - 面板、`novel_project action=show`、`novel_context` 的进度行**三处必须一致**，
 *   各写一份迟早会分叉（一处四舍五入一处向下取整，用户看到两个数）；
 * - 边界只有这里一处：没设目标（`undefined` / 0）时**什么都不输出**，
 *   而不是输出"0%"或"目标 0 字"——老作品没有这个字段，输出必须与加这个功能之前逐字相同。
 */

/** 逗号分组的整数（`36400` → `36,400`），模型读起来不容易数错位 */
function group(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 字数进度文案；没有目标时返回 `null`（调用方用 `lines(...)` 直接跳过）。
 * 超出目标时如实报 >100%，不封顶——写超了是需要看见的事实。
 */
export function wordProgress(words: number, target: number | undefined | null): string | null {
  if (target === undefined || target === null || target <= 0) return null;
  const percent = Math.floor((words / target) * 100);
  return `${group(words)} / ${group(target)} words (${percent}% of the target)`;
}
