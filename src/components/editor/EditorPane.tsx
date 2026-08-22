import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Check, CircleDot, Search } from "lucide-react";
import { Editor, type EditorHandle } from "./Editor";
import { useActiveChapter, useProjectStore } from "../../stores/project";
import { countWords } from "../../lib/utils";

interface EditorPaneProps {
  onRequestAiAction?: (templateContent: string) => void;
}

export const EditorPane = forwardRef<EditorHandle, EditorPaneProps>(function EditorPane(
  { onRequestAiAction },
  ref,
) {
  // 内层 ref 指向真实 Editor（章节切换时 Editor 销毁重建，handle 随之变化）
  // 外层 ref 通过代理对象访问 —— 每次调用都读 innerRef.current 的最新值
  const innerRef = useRef<EditorHandle>(null);
  useImperativeHandle(
    ref,
    () =>
      new Proxy({} as EditorHandle, {
        get: (_, prop: keyof EditorHandle) => {
          const current = innerRef.current;
          if (!current) return undefined;
          const value = current[prop];
          return typeof value === "function" ? value.bind(current) : value;
        },
      }),
    [],
  );
  const chapter = useActiveChapter();
  const saveChapterContent = useProjectStore((s) => s.saveChapterContent);

  const [wordCount, setWordCount] = useState(0);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setWordCount(countWords(chapter?.content ?? ""));
    setDirty(false);
  }, [chapter?.id]);

  if (!chapter) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-400">
        选择或新建一个章节开始写作
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-ink-800 px-5">
        <span className="truncate text-sm font-medium text-ink-200">{chapter.title}</span>
        <span className="flex items-center gap-3 text-xs text-ink-400">
          <button
            onClick={() => innerRef.current?.openSearch()}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
            title="本章内搜索/替换（Ctrl+H 在某些浏览器可用）"
          >
            <Search size={13} />
          </button>
          <span>{wordCount} 字</span>
          {dirty ? (
            <span className="flex items-center gap-1 text-accent-400">
              <CircleDot size={12} /> 正在编辑
            </span>
          ) : (
            <span className="flex items-center gap-1 text-emerald-400/80">
              <Check size={13} /> 已保存
            </span>
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          ref={innerRef}
          chapterId={chapter.id!}
          initialContent={chapter.content}
          onChange={() => setDirty(true)}
          onSave={(content) => {
            setDirty(false);
            void saveChapterContent(chapter.id!, content);
          }}
          onWordCount={setWordCount}
          onRequestAiAction={onRequestAiAction}
        />
      </div>
    </div>
  );
});
