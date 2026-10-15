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

/* 左栏：上半章节、下半角色卡（各自滚动）。宽度与分隔线在这里，不在 .nnv-list 上——
   两者共用同一个左栏，谁都不该独占宽度。 */
.nnv-side {
  flex: 0 0 268px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}

.nnv-list {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.nnv-chars {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 42%;
  border-top: 1px solid var(--dsw-alias-border-l2);
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

.nnv-list-head .nnv-spacer { flex: 1 1 auto; }

.nnv-list-body { flex: 1 1 auto; overflow: auto; padding: 6px 8px 12px; }
.nnv-list-empty { display: block; padding: 6px 8px; }

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

/* 行内动作条：默认隐形，悬停/选中该行时才出现——读的时候界面要退到背后 */
.nnv-row-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
  opacity: 0;
  transition: opacity var(--ds-transition-duration-fast, 120ms) var(--ds-ease-in-out, ease);
}

.nnv-row:hover .nnv-row-actions,
.nnv-row[data-selected="true"] .nnv-row-actions,
.nnv-chars .nnv-row:focus-within .nnv-row-actions { opacity: 1; }

.nnv-act {
  min-width: 22px;
  height: 22px;
  padding: 0 5px;
  border: 1px solid transparent;
  border-radius: var(--dsw-radius-xs, 4px);
  background: none;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.nnv-act:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
}

.nnv-act:disabled { opacity: 0.35; cursor: default; }
.nnv-act[data-danger="true"] { color: var(--dsw-alias-state-warn-primary); white-space: nowrap; }

/* 行内表单（新建章节 / 改名） */
.nnv-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 7px 9px;
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-2);
}

.nnv-form-actions { display: flex; gap: 6px; justify-content: flex-end; }

.nnv-input {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-bg-base);
  color: inherit;
  font: inherit;
  font-size: 12.5px;
}

.nnv-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.nnv-input-sm { width: 8em; }

.nnv-check { flex: 0 0 auto; accent-color: var(--dsw-alias-brand-primary); }
.nnv-row-char { cursor: default; }
.nnv-file { display: none; }

/* 自检结论的小角标：读列表时一眼看出哪几章还没过 */
.nnv-badge {
  margin-left: 6px;
  padding: 1px 5px;
  border-radius: 999px;
  font-size: 10px;
  vertical-align: 1px;
  color: var(--dsw-alias-label-tertiary);
  border: 1px solid var(--dsw-alias-border-l2);
}

.nnv-badge[data-verdict="pass"] {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}

.nnv-badge[data-verdict="fail"] {
  color: var(--dsw-alias-state-warn-primary);
  border-color: var(--dsw-alias-state-warn-primary);
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

.nnv-body-headline { display: flex; align-items: center; gap: 8px; }
.nnv-body-headline .nnv-spacer { flex: 1 1 auto; }

.nnv-body-title { margin: 0; font-size: 1.32em; font-weight: 650; letter-spacing: 0.01em; }

.nnv-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 0 11px; }

.nnv-goal {
  padding: 0 0 10px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}

.nnv-edit-hint { padding: 0 0 10px; }

/* 目标字数：读状态是一个按钮（点一下进入编辑），编辑态是一行输入 */
.nnv-target {
  padding: 2px 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  white-space: nowrap;
}

.nnv-target:hover {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
}

.nnv-target-edit { display: flex; align-items: center; gap: 5px; }

/* 正文编辑态：textarea 占满剩余高度，等宽字体便于对 Markdown */
.nnv-edit { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; padding: 16px 26px 20px; }

.nnv-textarea {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  max-width: 52em;
  margin: 0 auto;
  box-sizing: border-box;
  padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-1);
  color: inherit;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 13px;
  line-height: 1.75;
  resize: none;
}

.nnv-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }

.nnv-edit-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 52em;
  margin: 10px auto 0;
}

.nnv-edit-actions .nnv-spacer { flex: 1 1 auto; }

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

.nnv-chip[data-tone="warn"] {
  color: var(--dsw-alias-state-warn-primary);
  border-color: var(--dsw-alias-state-warn-primary);
  background: transparent;
}

/* 操作成功的提示：与错误同一个位置，但用中性的语气 */
.nnv-notice {
  margin: 14px 26px;
  padding: 9px 14px;
  border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  font-size: 12.5px;
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
