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
/* 面板内一律 border-box：.nnv-row 的 width:100% 配上默认的 content-box 会宽出内边距那几像素，
   于是列表里冒出横向溢出——表现是滚动区底部一条细横线，看着像莫名其妙的分隔线。 */
.nnv-root, .nnv-root *, .nnv-root *::before, .nnv-root *::after { box-sizing: border-box; }

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
/* 声明 304px 就必须是 304px：flex 项的 min-width:auto 会被内容（行内的角标 + 动作按钮）
   撑开——量出来是 312px，而"我设了宽度却没生效"这种偏差在截图里看不出来。 */
.nnv-side {
  flex: 0 0 340px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--dsw-alias-border-l2);
  /* 主题里 bg-base / bg-layer-1/2/3 全是 #fff（实测值），只有这个是真正的"面板灰"——
     外壳自己的侧栏就用它。左栏灰、正文白，才有"导航 vs 纸面"的层次。 */
  background: var(--dsw-specific-sidebar-fill);
}

/* 章节列表只占它需要的高度（上限 60%），角色卡区接在下面并**填满剩下的高度**：
   两段都不长时，空白落在有边框的区块里（像真的侧栏），而不是悬在中间。
   顺带说明上面那句 background：实测这个主题的 bg-base / bg-layer-1/2/3 全是 #fff，
   只有 --dsw-specific-sidebar-fill（#f9fafb）是真正的"面板灰"，但对比度只有 2%——
   所以层次主要还是靠边框与留白，别指望底色。 */
.nnv-list {
  flex: 0 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 60%;
}

.nnv-chars {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--dsw-alias-border-l2);
}

.nnv-list-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px 8px;
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--dsw-alias-label-tertiary);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

.nnv-list-head .nnv-spacer { flex: 1 1 auto; }

/* 计数单独一档：以前它和"＋ 新建"按钮紧贴着，看起来像按钮的一部分 */
.nnv-count {
  min-width: 1.2em;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary);
}

.nnv-list-head > button:last-child { margin-left: 6px; }

.nnv-list-body { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; padding: 6px 8px 12px; }
.nnv-list-empty { display: block; padding: 6px 8px; }

.nnv-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 8px 7px 9px;
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
  width: 1.6em;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary);
}

.nnv-row-main { display: flex; flex-direction: column; gap: 3px; flex: 1 1 auto; min-width: 0; }

.nnv-row-title {
  display: block;
  font-size: 13px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nnv-row-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary);
}

.nnv-words { flex: 0 0 auto; }

/* 体量条：短、细、有底槽——以前它占满整行且没有轨道，看起来像一条下划线残留。
   最长的那一章 = 满格（按最长章节归一化，不写死"多少字算长"）。 */
.nnv-bar {
  flex: 0 0 auto;
  width: 56px;
  height: 4px;
  border-radius: 999px;
  background: var(--dsw-alias-border-l1);
  overflow: hidden;
}

.nnv-bar-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--dsw-alias-border-l2);
}

.nnv-row[data-selected="true"] .nnv-bar-fill { background: var(--dsw-alias-brand-primary); }
/* 拖拽排序：按下时抓住（grab），拖动中把落点画成一条线。
   落点线用伪元素画在行内，不占布局高度，所以拖过时列表不跳。 */
.nnv-row { cursor: default; }
.nnv-row[data-drag="true"] { opacity: 0.55; cursor: grabbing; }
.nnv-row[data-drop="before"]::before,
.nnv-row[data-drop="after"]::after {
  content: "";
  position: absolute;
  left: 6px;
  right: 6px;
  height: 2px;
  background: var(--dsw-alias-brand-primary);
  border-radius: 2px;
}
.nnv-row[data-drop="before"]::before { top: -1px; }
.nnv-row[data-drop="after"]::after { bottom: -1px; }
/* 伪元素要相对行定位；行本身是 flex 容器，position: relative 不影响布局 */
.nnv-row { position: relative; }

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
  min-width: 20px;
  height: 20px;
  padding: 0 4px;
  border: 1px solid transparent;
  border-radius: var(--dsw-radius-xs, 4px);
  background: none;
  color: var(--dsw-alias-label-secondary);
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

/* 角色卡：首字头像（有真头像的加一个小圆点标记）。比"checkbox + 名字"像人。 */
.nnv-avatar {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 1px solid var(--dsw-alias-border-l2);
  font-size: 12px;
  line-height: 1;
  color: var(--dsw-alias-label-secondary);
  user-select: none;
}

.nnv-avatar-dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 1.5px var(--dsw-specific-sidebar-fill);
}

/* 不参与写作的卡整体变淡：状态一眼可辨，不必去逐个看 checkbox */
.nnv-row-char[data-active="false"] .nnv-row-title { color: var(--dsw-alias-label-tertiary); }
.nnv-row-char[data-active="false"] .nnv-avatar { opacity: 0.55; }

/* 参与开关的胶囊态：参与 = 品牌色描边，不参与 = 灰描边（行本身还会整体变淡） */
.nnv-toggle {
  flex: 0 0 auto;
  padding: 1.5px 9px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: none;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 10.5px;
  line-height: 1.6;
  cursor: pointer;
}

.nnv-toggle[data-on="true"] {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}

.nnv-toggle:disabled { opacity: 0.5; cursor: default; }
.nnv-row-char { cursor: default; padding-top: 5px; padding-bottom: 5px; }
.nnv-file { display: none; }

/* 自检结论的小角标：靠右、贴齐动作区，不再挤在标题后面 */
.nnv-badge {
  flex: 0 0 auto;
  padding: 1.5px 6px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 1.5;
  white-space: nowrap;
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

/* 注意：.nnv-row* 与 .nnv-bar* 的样式只在上面那一处定义。
   这里曾经留着第一版的同名规则（.nnv-bar { flex: 1 1 auto } 等），CSS 同权重按顺序取后者，
   于是改上面那份**看不出任何效果**——量出来才发现行内体量条宽 62px 而不是 34px。 */

/* ── 正文区 ─────────────────────────────────────────────── */
.nnv-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--dsw-alias-bg-base);
}

/* 读的一列：标题、标签、正文、编辑器**共用同一列宽与同一左边缘**。
   以前标题贴左边、正文自己居中，两者左边缘差几十像素——看起来像没对齐的 bug，而不是排版。
   宽度用 rem 而不是 em：em 会按各自的 font-size 解析（标题区 14px、正文 15px），
   于是同一份 42em 算出来 588px 与 600px——又差 12px。 */
.nnv-page {
  width: 100%;
  max-width: 40rem;
  margin: 0 auto;
  padding: 0 30px;
  box-sizing: border-box;
}

/* 分隔线画在**列**上，不画在整个右栏上：横跨 855px 的线配上中间 640px 的文字块，
   视觉上像"线跑出去了"。收到 .nnv-page 上，线和文字同宽。 */
.nnv-body-head {
  flex: 0 0 auto;
  padding: 15px 0 0;
}

.nnv-body-head .nnv-page {
  padding-bottom: 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

.nnv-body-headline { display: flex; align-items: center; gap: 8px; }
.nnv-body-headline .nnv-spacer { flex: 1 1 auto; }

/* 章标题：只放大、加重，不换字体（与正文同一套无衬线） */
.nnv-body-title {
  margin: 0;
  font-size: 1.45em;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.nnv-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 9px 0 11px; }

.nnv-goal {
  padding: 0 0 11px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}

.nnv-edit-hint { padding: 0 0 11px; }

/* 目标字数：读状态是一个按钮（点一下进入编辑），编辑态是一行输入 */
.nnv-target {
  margin-left: 4px;
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
.nnv-edit { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; padding: 18px 0 22px; }

.nnv-edit-inner { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }

.nnv-textarea {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 15px 17px;
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
  padding-top: 10px;
}

.nnv-edit-actions .nnv-spacer { flex: 1 1 auto; }

/* 一行里所有标签**同一种形状**：描边胶囊，只有文字颜色按语义分档。
   以前"第 N 章 / 字数 / 标签"用平台 Tag（灰底实心），"自检结论 / 参与写作"用这里的描边胶囊，
   两种风格并排放在一行里，看着就是"两种东西拼在一起"。统一之后信息层级靠颜色区分。 */
.nnv-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1.5px 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
  background: none;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.nnv-chip[data-tone="brand"] {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}

.nnv-chip[data-tone="warn"] {
  color: var(--dsw-alias-state-warn-primary);
  border-color: var(--dsw-alias-state-warn-primary);
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

.nnv-read { flex: 1 1 auto; overflow: auto; padding: 34px 26px 96px; scroll-behavior: smooth; }

/* **正文不换衬线体**：试过 Georgia + 宋体兜底，实测"不如无衬线好看"（用户反馈）——
   中文在 17px 下宋体的笔画偏细、和界面的无衬线字形混在一起显脏。字号/行距保留。
   列宽/边距只由 .nnv-page 决定：这里再写一份 max-width 会和它打架（同权重看顺序）。 */
.nnv-prose {
  font-size: calc(var(--dsh-content-font-size, 14px) + 3px);
  line-height: 2;
  letter-spacing: 0.01em;
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
