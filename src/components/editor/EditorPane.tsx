import { forwardRef, useEffect, useState } from "react";
import { Check, CircleDot } from "lucide-react";
import { Editor, type EditorHandle } from "./Editor";
import { useActiveChapter, useProjectStore } from "../../stores/project";
import { countWords } from "../../lib/utils";

export const EditorPane = forwardRef<EditorHandle>(function EditorPane(_, ref) {
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
          ref={ref}
          chapterId={chapter.id!}
          initialContent={chapter.content}
          onChange={() => setDirty(true)}
          onSave={(content) => {
            setDirty(false);
            void saveChapterContent(chapter.id!, content);
          }}
          onWordCount={setWordCount}
        />
      </div>
    </div>
  );
});
