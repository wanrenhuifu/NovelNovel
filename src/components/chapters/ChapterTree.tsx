import { useState } from "react";
import { Plus, FileText, Trash2, Check, ChevronUp, ChevronDown } from "lucide-react";
import { useProjectStore } from "../../stores/project";

export function ChapterTree() {
  const chapters = useProjectStore((s) => s.chapters);
  const activeChapterId = useProjectStore((s) => s.activeChapterId);
  const setActiveChapter = useProjectStore((s) => s.setActiveChapter);
  const createChapter = useProjectStore((s) => s.createChapter);
  const renameChapter = useProjectStore((s) => s.renameChapter);
  const deleteChapter = useProjectStore((s) => s.deleteChapter);
  const moveChapter = useProjectStore((s) => s.moveChapter);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

  const startEdit = (id: number, current: string) => {
    setEditingId(id);
    setEditValue(current);
  };

  const commitEdit = async () => {
    if (editingId != null) {
      await renameChapter(editingId, editValue);
      setEditingId(null);
    }
  };

  const handleNew = async () => {
    if (activeProjectId == null) return;
    const id = await createChapter(activeProjectId);
    await useProjectStore.getState().setActiveChapter(id);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">
          <FileText size={13} /> 章节
        </span>
        <button
          onClick={handleNew}
          disabled={activeProjectId == null}
          className="flex items-center gap-1 rounded-md bg-accent-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-accent-500 disabled:opacity-50"
        >
          <Plus size={12} /> 新建
        </button>
      </div>

      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {chapters.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-ink-400">
            暂无章节，点击“新建”开始。
          </div>
        )}
        {chapters.map((c, index) => {
          const isActive = c.id === activeChapterId;
          const isEditing = editingId === c.id;
          const isConfirming = confirmingId === c.id;
          return (
            <div
              key={c.id}
              className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors ${
                isActive
                  ? "bg-ink-800 text-ink-100"
                  : "text-ink-300 hover:bg-ink-850"
              }`}
              onClick={() => {
                setActiveChapter(c.id!);
                setConfirmingId(null);
              }}
            >
              {isEditing ? (
                <>
                  <input
                    autoFocus
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-full rounded bg-ink-700 px-1.5 py-0.5 text-sm text-ink-100 outline-none ring-1 ring-accent-500"
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      commitEdit();
                    }}
                    className="text-ink-300 hover:text-accent-400"
                  >
                    <Check size={14} />
                  </button>
                </>
              ) : (
                <>
                  <span
                    className="min-w-0 flex-1 truncate"
                    onDoubleClick={() => startEdit(c.id!, c.title)}
                    title={c.title}
                  >
                    {c.title}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void moveChapter(c.id!, -1);
                    }}
                    disabled={index === 0}
                    className="hidden text-ink-400 hover:text-accent-400 disabled:opacity-30 group-hover:block"
                    title="上移"
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void moveChapter(c.id!, 1);
                    }}
                    disabled={index === chapters.length - 1}
                    className="hidden text-ink-400 hover:text-accent-400 disabled:opacity-30 group-hover:block"
                    title="下移"
                  >
                    <ChevronDown size={13} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      startEdit(c.id!, c.title);
                    }}
                    className="hidden text-[11px] text-ink-400 hover:text-accent-400 group-hover:block"
                    title="重命名"
                  >
                    改
                  </button>
                  {isConfirming ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteChapter(c.id!);
                        setConfirmingId(null);
                      }}
                      className="rounded bg-red-950/70 px-1.5 py-0.5 text-[11px] font-medium text-red-300 hover:bg-red-900/70"
                      title="再次点击确认删除"
                    >
                      确认删除？
                    </button>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmingId(c.id!);
                      }}
                      className="hidden text-ink-400 hover:text-red-400 group-hover:block"
                      title="删除章节"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="border-t border-ink-800 px-3 py-1.5 text-[11px] text-ink-400">
        双击重命名 · 悬停可排序 / 删除
      </div>
    </div>
  );
}
