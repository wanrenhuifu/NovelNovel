import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
} from "@codemirror/search";
import { Sparkles } from "lucide-react";
import { countWords } from "../../lib/utils";
import { useSettingsStore } from "../../stores/settings";
import { defaultInstructionTemplates } from "../../types";

export interface EditorHandle {
  /** 在文档末尾追加文本 */
  insertAtEnd: (text: string) => void;
  /** 替换当前选区（无选区则插入到光标处） */
  replaceSelection: (text: string) => void;
  /** 获取选区文本（无选区返回空串） */
  getSelection: () => string;
  /** 光标定位到指定字符位置并滚动到视野中央（搜索结果跳转用） */
  revealPos: (pos: number) => void;
  getContent: () => string;
  /** 打开 CodeMirror 内置搜索/替换面板（Ctrl+F 被浏览器拦截，用按钮触发） */
  openSearch: () => void;
}

interface Props {
  chapterId: number;
  initialContent: string;
  onSave: (content: string) => void;
  /** 文档每次变化时立即触发（早于防抖保存） */
  onChange?: () => void;
  onWordCount?: (count: number) => void;
  /** 用户在右键菜单里点击 AI 模板时回调，参数是模板内容（含 {{selection}} 占位） */
  onRequestAiAction?: (templateContent: string) => void;
}

interface MenuPos {
  x: number;
  y: number;
}

const theme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--color-ink-100)",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--color-accent-400)",
    borderLeftWidth: "2px",
  },
  "&.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(217, 119, 6, 0.25)",
  },
  ".cm-selectionBackground": {
    backgroundColor: "rgba(217, 119, 6, 0.18)",
  },
  ".cm-placeholder": {
    color: "var(--color-ink-600)",
    fontStyle: "italic",
  },
});

export const Editor = forwardRef<EditorHandle, Props>(function Editor(
  { chapterId, initialContent, onSave, onChange, onWordCount, onRequestAiAction },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const onSaveRef = useRef(onSave);
  const onChangeRef = useRef(onChange);
  const onWordCountRef = useRef(onWordCount);
  const onRequestAiActionRef = useRef(onRequestAiAction);
  onSaveRef.current = onSave;
  onChangeRef.current = onChange;
  onWordCountRef.current = onWordCount;
  onRequestAiActionRef.current = onRequestAiAction;
  const [ready, setReady] = useState(false);

  // 右键菜单状态
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const templates =
    useSettingsStore((s) => s.settings?.instructionTemplates) ?? defaultInstructionTemplates;

  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      onChangeRef.current?.();
      const content = update.state.doc.toString();
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        onSaveRef.current(content);
        onWordCountRef.current?.(countWords(content));
      }, 600);
    });

    // 右键菜单：有选区时拦截 contextmenu，阻止默认菜单并显示自定义 AI 菜单
    const contextMenuHandler = EditorView.domEventHandlers({
      contextmenu(event, view) {
        const { from, to } = view.state.selection.main;
        if (from === to) return false; // 无选区走浏览器默认菜单
        event.preventDefault();
        setMenuPos({ x: event.clientX, y: event.clientY });
        return true;
      },
    });

    const view = new EditorView({
      state: EditorState.create({
        doc: initialContent,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          // 不挂 codeLanguages：language-data 会把全部编程语言模式打进产物，小说写作不需要
          markdown({ base: markdownLanguage }),
          placeholder("从这里开始你的故事……"),
          theme,
          EditorView.lineWrapping,
          // Ctrl+F 搜索面板（支持替换、正则、大小写敏感）、Ctrl+G 跳转到行；
          // highlightSelectionMatches 高亮选中文本在文档中的所有出现
          search({ top: true }),
          highlightSelectionMatches(),
          updateListener,
          contextMenuHandler,
        ],
      }),
      parent: containerRef.current,
    });
    viewRef.current = view;
    onWordCountRef.current?.(countWords(initialContent));
    setReady(true);

    return () => {
      window.clearTimeout(saveTimer.current);
      view.destroy();
      viewRef.current = null;
      setReady(false);
    };
    // chapterId 变化时销毁重建，initialContent 只在创建时使用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId]);

  // 选区变化 / 点击 / 滚动时关闭菜单（避免菜单位置错位或作用于已失效的选区）
  useEffect(() => {
    if (!menuPos) return;
    const close = () => setMenuPos(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuPos]);

  useImperativeHandle(ref, () => ({
    insertAtEnd(text: string) {
      const view = viewRef.current;
      if (!view) return;
      const end = view.state.doc.length;
      const prefix = end > 0 && !view.state.doc.toString().endsWith("\n") ? "\n\n" : "";
      view.dispatch({
        changes: { from: end, insert: prefix + text },
        selection: { anchor: end + prefix.length + text.length },
        scrollIntoView: true,
      });
      const content = view.state.doc.toString();
      onSaveRef.current(content);
      onWordCountRef.current?.(countWords(content));
    },
    replaceSelection(text: string) {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch(view.state.replaceSelection(text));
      const content = view.state.doc.toString();
      onSaveRef.current(content);
      onWordCountRef.current?.(countWords(content));
    },
    getSelection() {
      const view = viewRef.current;
      if (!view) return "";
      const { from, to } = view.state.selection.main;
      return view.state.doc.sliceString(from, to);
    },
    revealPos(pos: number) {
      const view = viewRef.current;
      if (!view) return;
      const clamped = Math.max(0, Math.min(pos, view.state.doc.length));
      view.dispatch({
        selection: { anchor: clamped },
        effects: EditorView.scrollIntoView(clamped, { y: "center" }),
      });
      view.focus();
    },
    getContent() {
      return viewRef.current?.state.doc.toString() ?? "";
    },
    openSearch() {
      const view = viewRef.current;
      if (!view) return;
      openSearchPanel(view);
    },
  }));

  return (
    <div className="relative h-full overflow-y-auto">
      <div ref={containerRef} className="mx-auto min-h-full max-w-3xl px-8" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-400">
          加载编辑器…
        </div>
      )}
      {menuPos && (
        <div
          className="fixed z-50 min-w-44 rounded-md border border-ink-700 bg-ink-900 py-1 text-sm shadow-xl"
          style={{ left: menuPos.x, top: menuPos.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-1.5 px-3 py-1 text-[11px] text-ink-400">
            <Sparkles size={11} /> AI 指令
          </div>
          {templates.length === 0 ? (
            <div className="px-3 py-1.5 text-xs text-ink-500">
              暂无模板，可在设置中添加
            </div>
          ) : (
            templates.map((t) => (
              <button
                key={t.id}
                className="block w-full truncate px-3 py-1.5 text-left text-ink-200 hover:bg-ink-800"
                onClick={() => {
                  onRequestAiActionRef.current?.(t.content);
                  setMenuPos(null);
                }}
                title={t.name}
              >
                {t.name}
              </button>
            ))
          )}
          <div className="my-1 border-t border-ink-800" />
          <button
            className="block w-full px-3 py-1.5 text-left text-ink-400 hover:bg-ink-800"
            onClick={async () => {
              const view = viewRef.current;
              if (view) {
                const { from, to } = view.state.selection.main;
                const text = view.state.doc.sliceString(from, to);
                try {
                  await navigator.clipboard.writeText(text);
                } catch {
                  // clipboard API 不可用时回退
                  const ta = document.createElement("textarea");
                  ta.value = text;
                  document.body.appendChild(ta);
                  ta.select();
                  document.execCommand("copy");
                  document.body.removeChild(ta);
                }
              }
              setMenuPos(null);
            }}
          >
            复制选区
          </button>
        </div>
      )}
    </div>
  );
});
