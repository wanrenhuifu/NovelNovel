import { useMemo, useRef, useState } from "react";
import {
  Plus,
  FileText,
  Trash2,
  Check,
  ChevronUp,
  ChevronDown,
  GripVertical,
  Tag,
  X,
} from "lucide-react";
import { useProjectStore } from "../../stores/project";
import { countWords } from "../../lib/utils";

type DropPosition = "before" | "after";

export function ChapterTree() {
  const chapters = useProjectStore((s) => s.chapters);
  const activeChapterId = useProjectStore((s) => s.activeChapterId);
  const setActiveChapter = useProjectStore((s) => s.setActiveChapter);
  const createChapter = useProjectStore((s) => s.createChapter);
  const renameChapter = useProjectStore((s) => s.renameChapter);
  const deleteChapter = useProjectStore((s) => s.deleteChapter);
  const moveChapter = useProjectStore((s) => s.moveChapter);
  const reorderChapters = useProjectStore((s) => s.reorderChapters);
  const addChapterTag = useProjectStore((s) => s.addChapterTag);
  const removeChapterTag = useProjectStore((s) => s.removeChapterTag);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [addingTagId, setAddingTagId] = useState<number | null>(null);
  const [newTagValue, setNewTagValue] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  // 拖拽状态：state 驱动渲染，ref 同步镜像供事件处理器读取（避免首次 dragover 读到旧值）
  const [dragId, setDragIdState] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: number;
    position: DropPosition;
  } | null>(null);
  const dragIdRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const setDragId = (id: number | null) => {
    dragIdRef.current = id;
    setDragIdState(id);
  };

  // store 里的章节内容随保存实时同步，统计始终基于最新正文
  const totalWords = useMemo(
    () => chapters.reduce((sum, c) => sum + countWords(c.content), 0),
    [chapters],
  );

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

  // 通过 data-chapter-id 查找行元素，避免每次渲染重建 callback ref
  const findRow = (id: number): HTMLDivElement | null =>
    listRef.current?.querySelector<HTMLDivElement>(
      `[data-chapter-id="${id}"]`,
    ) ?? null;

  const handleDragStart = (e: React.DragEvent, id: number) => {
    setDragId(id);
    // dataTransfer 必须有数据才能触发 drop（Firefox 要求）；值本身不用
    e.dataTransfer.setData("text/plain", String(id));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, id: number) => {
    const current = dragIdRef.current;
    if (current == null || current === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const el = findRow(id);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const position: DropPosition =
      e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setDropTarget((cur) =>
      cur && cur.id === id && cur.position === position ? cur : { id, position },
    );
  };

  const handleDrop = (e: React.DragEvent, targetId: number) => {
    e.preventDefault();
    const current = dragIdRef.current;
    if (current == null) return;
    const el = findRow(targetId);
    let position: DropPosition = "after";
    if (el) {
      const rect = el.getBoundingClientRect();
      position = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    }
    void reorderChapters(current, targetId, position);
    setDragId(null);
    setDropTarget(null);
  };

  const handleDragEnd = () => {
    setDragId(null);
    setDropTarget(null);
  };

  const handleDragLeave = (id: number, e: React.DragEvent) => {
    // 只在真正离开本行时清掉落点：relatedTarget 仍在行内就不清
    const row = findRow(id);
    if (!row) return;
    const related = e.relatedTarget as Node | null;
    if (related && row.contains(related)) return;
    setDropTarget((cur) => (cur?.id === id ? null : cur));
  };

  // 标签管理
  const commitAddTag = async (chapterId: number) => {
    if (newTagValue.trim()) {
      await addChapterTag(chapterId, newTagValue);
    }
    setAddingTagId(null);
    setNewTagValue("");
  };

  // 收集所有出现过的标签（用于筛选下拉）
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    chapters.forEach((c) => c.tags.forEach((t) => tagSet.add(t)));
    return Array.from(tagSet).sort();
  }, [chapters]);

  // 按标签筛选章节
  const filteredChapters = useMemo(() => {
    if (!tagFilter) return chapters;
    return chapters.filter((c) => c.tags.includes(tagFilter));
  }, [chapters, tagFilter]);

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

      {/* 标签筛选 */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-ink-800 px-3 py-1.5">
          <Tag size={11} className="text-ink-500" />
          <button
            onClick={() => setTagFilter(null)}
            className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${
              tagFilter == null
                ? "bg-accent-600/20 text-accent-400"
                : "text-ink-400 hover:bg-ink-800 hover:text-ink-200"
            }`}
          >
            全部
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
              className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                tagFilter === tag
                  ? "bg-accent-600/20 text-accent-400"
                  : "text-ink-400 hover:bg-ink-800 hover:text-ink-200"
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      <div ref={listRef} className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {filteredChapters.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-ink-400">
            {chapters.length === 0 ? '暂无章节，点击"新建"开始。' : "无匹配章节"}
          </div>
        )}
        {filteredChapters.map((c) => {
          const realIdx = chapters.findIndex((ch) => ch.id === c.id);
          const isActive = c.id === activeChapterId;
          const isEditing = editingId === c.id;
          const isConfirming = confirmingId === c.id;
          const isDragging = dragId === c.id;
          const isDropTarget = dropTarget?.id === c.id;
          const dropPosition = isDropTarget ? dropTarget!.position : null;
          return (
            <div
              key={c.id}
              data-chapter-id={c.id}
              draggable={!isEditing}
              onDragStart={(e) => handleDragStart(e, c.id!)}
              onDragOver={(e) => handleDragOver(e, c.id!)}
              onDrop={(e) => handleDrop(e, c.id!)}
              onDragEnd={handleDragEnd}
              onDragLeave={(e) => handleDragLeave(c.id!, e)}
              className={`group relative flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors ${
                isDragging ? "opacity-40" : ""
              } ${
                isActive
                  ? "bg-ink-800 text-ink-100"
                  : "text-ink-300 hover:bg-ink-850"
              }`}
              onClick={() => {
                setActiveChapter(c.id!);
                setConfirmingId(null);
              }}
            >
              {/* 落点指示条 */}
              {isDropTarget && dropPosition === "before" && (
                <span className="pointer-events-none absolute inset-x-1 -top-0.5 h-0.5 rounded-full bg-accent-400" />
              )}
              {isDropTarget && dropPosition === "after" && (
                <span className="pointer-events-none absolute inset-x-1 -bottom-0.5 h-0.5 rounded-full bg-accent-400" />
              )}

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
                    className="hidden cursor-grab text-ink-500 group-hover:block active:cursor-grabbing"
                    title="拖拽排序"
                  >
                    <GripVertical size={13} />
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate"
                    onDoubleClick={() => startEdit(c.id!, c.title)}
                    title={c.title}
                  >
                    {c.title}
                  </span>
                  {/* 标签芯片 */}
                  {c.tags.map((tag) => (
                    <span
                      key={tag}
                      className="group/tag flex items-center gap-0.5 rounded bg-ink-700/60 px-1 py-0.5 text-[10px] text-ink-300"
                      title={`${tag}（点击移除）`}
                    >
                      {tag}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeChapterTag(c.id!, tag);
                        }}
                        className="text-ink-500 opacity-0 hover:text-red-400 group-hover/tag:opacity-100"
                        title="移除标签"
                      >
                        <X size={9} />
                      </button>
                    </span>
                  ))}
                  {/* 添加标签 */}
                  {addingTagId === c.id ? (
                    <input
                      autoFocus
                      value={newTagValue}
                      onChange={(e) => setNewTagValue(e.target.value)}
                      onBlur={() => void commitAddTag(c.id!)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void commitAddTag(c.id!);
                        if (e.key === "Escape") {
                          setAddingTagId(null);
                          setNewTagValue("");
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      placeholder="标签名…"
                      className="w-16 rounded bg-ink-700 px-1 py-0.5 text-[10px] text-ink-100 outline-none ring-1 ring-accent-500"
                    />
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setAddingTagId(c.id!);
                        setNewTagValue("");
                      }}
                      className="hidden text-ink-500 hover:text-accent-400 group-hover:block"
                      title="添加标签"
                    >
                      <Tag size={11} />
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void moveChapter(c.id!, -1);
                    }}
                    disabled={realIdx === 0}
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
                    disabled={realIdx === chapters.length - 1}
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
      <div className="flex items-center justify-between border-t border-ink-800 px-3 py-1.5 text-[11px] text-ink-400">
        <span>拖拽排序 · 双击重命名 · 悬停更多</span>
        <span title="全书正文字数">共 {totalWords.toLocaleString()} 字</span>
      </div>
    </div>
  );
}
