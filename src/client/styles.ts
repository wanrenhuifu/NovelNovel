/**
 * 面板样式：按首方约定注入一段 CSS 文本。
 *
 * 不用 Tailwind，也不引任何 CSS 工具链：颜色一律走 `--dsw-*` 设计 token，
 * 这样浅色/深色主题切换与后续主题变更都不需要改代码。
 * 类名用 `nnv-` 前缀，避免与首方样式相撞。
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
}

.nnv-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  flex: 0 0 auto;
}

.nnv-title { font-weight: 600; }
.nnv-spacer { flex: 1 1 auto; }

.nnv-muted { color: var(--dsw-alias-label-tertiary); }
.nnv-small { font-size: 12px; }

.nnv-columns {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

.nnv-list {
  flex: 0 0 240px;
  overflow: auto;
  border-right: 1px solid var(--dsw-alias-border-l2);
  padding: 6px 0;
}

.nnv-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.nnv-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 14px;
  cursor: pointer;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  width: 100%;
  text-align: left;
}

.nnv-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.nnv-row[data-selected="true"] { background: var(--dsw-alias-interactive-bg-active); }

.nnv-row-title {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nnv-content {
  flex: 1 1 auto;
  overflow: auto;
  padding: 18px 22px;
  max-width: 44em;
}

.nnv-content h1 {
  font-size: 1.35em;
  margin: 0 0 4px;
}

.nnv-content h2 {
  font-size: 1.1em;
  margin: 1.4em 0 0.4em;
}

.nnv-content p { margin: 0 0 0.9em; line-height: 1.75; }
.nnv-content hr { border: none; border-top: 1px solid var(--dsw-alias-border-l2); margin: 1.4em 0; }

.nnv-tags { display: flex; gap: 6px; flex-wrap: wrap; margin: 2px 0 10px; }

.nnv-empty {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
  padding: 24px;
}

.nnv-error {
  margin: 14px;
  padding: 12px 14px;
  border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-label);
  background: var(--dsw-alias-state-warn-secondary);
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
