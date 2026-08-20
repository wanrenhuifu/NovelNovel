import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { countWords } from "../../lib/utils";

export interface EditorHandle {
  /** 在文档末尾追加文本 */
  insertAtEnd: (text: string) => void;
  /** 替换当前选区（无选区则插入到光标处） */
  replaceSelection: (text: string) => void;
  getContent: () => string;
}

interface Props {
  chapterId: number;
  initialContent: string;
  onSave: (content: string) => void;
  /** 文档每次变化时立即触发（早于防抖保存） */
  onChange?: () => void;
  onWordCount?: (count: number) => void;
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
  { chapterId, initialContent, onSave, onChange, onWordCount },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const onSaveRef = useRef(onSave);
  const onChangeRef = useRef(onChange);
  const onWordCountRef = useRef(onWordCount);
  onSaveRef.current = onSave;
  onChangeRef.current = onChange;
  onWordCountRef.current = onWordCount;
  const [ready, setReady] = useState(false);

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

    const view = new EditorView({
      state: EditorState.create({
        doc: initialContent,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          // 不挂 codeLanguages：language-data 会把全部编程语言模式打进产物，小说写作不需要
          markdown({ base: markdownLanguage }),
          placeholder("从这里开始你的故事……"),
          theme,
          EditorView.lineWrapping,
          updateListener,
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
    getContent() {
      return viewRef.current?.state.doc.toString() ?? "";
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
    </div>
  );
});
