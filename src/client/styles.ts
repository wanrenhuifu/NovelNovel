/**
 * 面板样式。
 *
 * 两条硬约束：
 * - 颜色只用 `--dsw-*` 设计 token（`cordis_inspect_query provider=Theme` 可列全），
 *   这样浅色/深色主题切换、以及将来换主题，都不需要改这里一行。
 * - 尺寸/字体同样优先 token，缺省值兜底；类名统一 `nnv-` 前缀避免与首方相撞。
 *
 * 视觉取向：像在读一本排版讲究的书——窄行宽、够大的行距、克制的分隔线；
 * 界面本身退到背后，只有数据和动作往前站。
 */
const STYLE_ID = "dsh-novelnovel-styles";

export const CSS = `
.nnv-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--dsw-alias-label-primary);
  font-size: var(--dsh-content-font-size, 14px);
  background: var(--dsw-alias-bg-base);
}

/* ── 顶栏 ───────────────────────────────────────────────── */
.nnv-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-1));
  flex: 0 0 auto;
}

.nnv-brand { display: flex; align-items: center; gap: 7px; min-width: 0; }

.nnv-title {
  font-weight: 600;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nnv-stats {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.nnv-dot { opacity: 0.45; }
.nnv-spacer { flex: 1 1 auto; }

/* ── 主体两栏 ───────────────────────────────────────────── */
.nnv-columns { display: flex; flex: 1 1 auto; min-height: 0; }

.nnv-list {
  flex: 0 0 268px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}

.nnv-list-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 14px 7px;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

.nnv-list-body { flex: 1 1 auto; overflow: auto; padding: 6px 8px 12px; }

.nnv-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--ds-transition-duration-fast, 120ms) var(--ds-ease-in-out, ease);
}

.nnv-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.nnv-row[data-selected="true"] {
  background: var(--dsw-alias-interactive-bg-active);
  box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary);
}

.nnv-row-index {
  flex: 0 0 auto;
  min-width: 1.7em;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary);
}

.nnv-row-main { flex: 1 1 auto; min-width: 0; }

.nnv-row-title {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nnv-row-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}

/* 章节体量条：一眼看出哪几章厚 */
.nnv-bar {
  position: relative;
  flex: 1 1 auto;
  height: 2px;
  border-radius: 2px;
  background: var(--dsw-alias-border-l2);
  overflow: hidden;
}

.nnv-bar-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--dsw-alias-brand-primary);
  opacity: 0.55;
}

.nnv-row[data-selected="true"] .nnv-bar-fill { opacity: 1; }

/* ── 正文区 ─────────────────────────────────────────────── */
.nnv-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--dsw-alias-bg-base);
}

.nnv-body-head {
  flex: 0 0 auto;
  padding: 13px 26px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

.nnv-body-title { margin: 0; font-size: 1.32em; font-weight: 650; letter-spacing: 0.01em; }

.nnv-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 0 11px; }

.nnv-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  font-variant-numeric: tabular-nums;
}

.nnv-chip[data-tone="brand"] {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  background: transparent;
}

.nnv-read { flex: 1 1 auto; overflow: auto; padding: 26px 26px 64px; scroll-behavior: smooth; }

.nnv-prose {
  max-width: 40em;
  margin: 0 auto;
  line-height: 1.85;
  font-size: calc(var(--dsh-content-font-size, 14px) + 1px);
}

.nnv-prose > p {
  margin: 0 0 1.05em;
  text-indent: 2em;          /* 中文小说的段落缩进 */
  text-align: justify;
}

.nnv-prose h2 { margin: 1.7em 0 0.7em; font-size: 1.08em; font-weight: 650; text-indent: 0; }

.nnv-prose blockquote {
  margin: 0 0 1.05em;
  padding: 2px 0 2px 14px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  text-indent: 0;
}

.nnv-prose .nnv-break {
  margin: 1.6em 0;
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
  letter-spacing: 0.5em;
  text-indent: 0;
}

/* 切换章节时的轻微淡入：不喧哗，但让人知道内容换了 */
@keyframes nnv-fade {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: none; }
}

.nnv-fade { animation: nnv-fade 160ms var(--ds-ease-in-out, ease); }

/* ── 空态 / 骨架 / 错误 ─────────────────────────────────── */
.nnv-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  flex: 1 1 auto;
  padding: 32px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
}

.nnv-center-title { color: var(--dsw-alias-label-primary); font-weight: 600; }
.nnv-hint { font-size: 12px; max-width: 34em; line-height: 1.7; }

.nnv-skel {
  height: 1em;
  margin: 0 0 0.85em;
  border-radius: var(--dsw-radius-xs, 4px);
  background: linear-gradient(90deg,
    var(--dsw-alias-bg-layer-2) 0%,
    var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2)) 50%,
    var(--dsw-alias-bg-layer-2) 100%);
  background-size: 200% 100%;
  animation: nnv-shimmer 1.1s linear infinite;
}

@keyframes nnv-shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}

.nnv-error {
  margin: 14px 26px;
  padding: 11px 14px;
  border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-primary);
  background: var(--dsw-alias-bg-layer-2);
  font-size: 12.5px;
  white-space: pre-wrap;
}
`;

/** 注入样式；重复调用只保留一份（HMR 重载时先移除旧的） */
export function installStyles(): void {
  const existing = document.getElementById(STYLE_ID);
  if (existing) existing.remove();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.dataset.pluginCss = "dsh-novelnovel";
  style.textContent = CSS;
  document.head.appendChild(style);
}
