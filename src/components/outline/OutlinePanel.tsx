import { useProjectStore } from "../../stores/project";
import { countWords } from "../../lib/utils";
import { FileText } from "lucide-react";

/**
 * 大纲视图：展示所有章节的标题 + 首段预览，点击跳转。
 * 只读视图，不修改章节内容；编辑仍走主编辑器。
 */
export function OutlinePanel({ onJumpToChapter }: { onJumpToChapter: (id: number) => void }) {
  const chapters = useProjectStore((s) => s.chapters);
  const activeChapterId = useProjectStore((s) => s.activeChapterId);

  if (chapters.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-ink-400">
        暂无章节
      </div>
    );
  }

  const totalWords = chapters.reduce((sum, c) => sum + countWords(c.content), 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-ink-800 px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">
          <FileText size={13} /> 大纲
        </span>
        <span className="text-[11px] text-ink-500">
          {chapters.length} 章 · {totalWords.toLocaleString()} 字
        </span>
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto px-2 py-2">
        {chapters.map((c, idx) => {
          const isActive = c.id === activeChapterId;
          const preview = extractPreview(c.content, 120);
          const words = countWords(c.content);
          return (
            <button
              key={c.id}
              onClick={() => onJumpToChapter(c.id!)}
              className={`block w-full rounded-md border px-3 py-2 text-left transition-colors ${
                isActive
                  ? "border-accent-500/40 bg-ink-800"
                  : "border-ink-800 bg-ink-900 hover:border-ink-700 hover:bg-ink-850"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium text-ink-100">
                  <span className="mr-1.5 text-[11px] text-ink-500">{idx + 1}.</span>
                  {c.title}
                </span>
                <span className="shrink-0 text-[11px] text-ink-500">{words} 字</span>
              </div>
              {preview && (
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-400">
                  {preview}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 取正文首段（到第一个 \n\n 或前 N 字符），折叠为单行 */
function extractPreview(content: string, maxLen: number): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  const firstPara = trimmed.split(/\n\s*\n/)[0] ?? trimmed;
  const collapsed = firstPara.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.slice(0, maxLen).trimEnd() + "…";
}
