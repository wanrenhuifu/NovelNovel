import { useEffect, useMemo, useRef, useState } from "react";
import { X, Search, CornerDownLeft } from "lucide-react";
import { useProjectStore } from "../../stores/project";
import { searchChapters, type SearchMatch } from "../../lib/search";

interface Props {
  onClose: () => void;
  /** 跳转到章节并定位正文位置（标题命中 pos 为 null 时只切章节） */
  onJump: (chapterId: number, pos: number | null) => void;
}

export function SearchModal({ onClose, onJump }: Props) {
  const chapters = useProjectStore((s) => s.chapters);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => searchChapters(chapters, query), [chapters, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const jump = (m: SearchMatch) => {
    onJump(m.chapterId, m.pos);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = results[selected];
      if (m) jump(m);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-xl flex-col rounded-xl border border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-3">
          <Search size={15} className="shrink-0 text-ink-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="在全部章节的标题与正文中搜索…"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink-100 outline-none placeholder:text-ink-600"
          />
          <button
            onClick={onClose}
            className="rounded-md p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
          >
            <X size={16} />
          </button>
        </div>

        <div ref={listRef} className="max-h-[55vh] overflow-y-auto p-2">
          {query.trim() === "" && (
            <p className="px-3 py-6 text-center text-xs text-ink-400">
              输入关键词搜索全书；↑↓ 选择，Enter 跳转到命中章节
            </p>
          )}
          {query.trim() !== "" && results.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-ink-400">
              没有找到“{query.trim()}”
            </p>
          )}
          {results.map((m, i) => (
            <button
              key={`${m.chapterId}-${m.pos ?? "title"}-${i}`}
              data-idx={i}
              onClick={() => jump(m)}
              onMouseEnter={() => setSelected(i)}
              className={`block w-full rounded-lg px-3 py-2 text-left ${
                i === selected ? "bg-ink-800" : "hover:bg-ink-850"
              }`}
            >
              <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-ink-400">
                <span className="truncate">{m.chapterTitle}</span>
                {m.pos != null && <span className="shrink-0">· 第 {m.pos + 1} 字符处</span>}
                {i === selected && (
                  <CornerDownLeft size={11} className="ml-auto shrink-0 text-accent-400" />
                )}
              </div>
              <p className="truncate text-sm leading-relaxed text-ink-200">
                {m.segments.map((seg, j) =>
                  seg.hit ? (
                    <mark
                      key={j}
                      className="rounded-sm bg-accent-600/40 px-0.5 text-ink-100"
                    >
                      {seg.text}
                    </mark>
                  ) : (
                    <span key={j}>{seg.text}</span>
                  ),
                )}
              </p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
