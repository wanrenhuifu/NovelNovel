import { useState } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import type { Project } from "../../types";
import { useProjectStore } from "../../stores/project";
import { uid } from "../../lib/utils";

interface Props {
  project: Project;
  onClose: () => void;
}

const inputCls =
  "w-full rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-sm text-ink-100 outline-none placeholder:text-ink-600 focus:border-accent-500";
const labelCls = "mb-1 block text-xs text-ink-400";

export function LorebookModal({ project, onClose }: Props) {
  const updateProject = useProjectStore((s) => s.updateProject);
  const [entries, setEntries] = useState(project.lorebook ?? []);
  const [saved, setSaved] = useState(false);

  const setEntry = (id: string, patch: Partial<(typeof entries)[number]>) => {
    setSaved(false);
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  const addEntry = () => {
    setSaved(false);
    setEntries((prev) => [
      ...prev,
      { id: uid(), name: "", keys: "", content: "", enabled: true },
    ]);
  };

  const removeEntry = (id: string) => {
    setSaved(false);
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  const save = async () => {
    await updateProject(project.id!, { lorebook: entries });
    setSaved(true);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
          <h2 className="text-base font-semibold text-ink-100">
            世界观 Lorebook
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <p className="text-[11px] leading-relaxed text-ink-400">
            词条带关键词时，仅当关键词出现在续写上下文中才注入提示词；不带关键词的条目为常驻设定，始终注入。
          </p>

          {entries.length === 0 && (
            <div className="rounded-md border border-dashed border-ink-700 px-3 py-6 text-center text-xs text-ink-400">
              暂无设定词条。点击“添加词条”创建世界观条目（势力、地点、物品、术语……）。
            </div>
          )}

          {entries.map((e) => (
            <div
              key={e.id}
              className="space-y-2 rounded-lg border border-ink-700 bg-ink-850/60 p-3"
            >
              <div className="flex items-center gap-2">
                <input
                  className={`${inputCls} flex-1`}
                  value={e.name}
                  onChange={(ev) => setEntry(e.id, { name: ev.target.value })}
                  placeholder="词条名，如：影阁"
                />
                <label className="flex items-center gap-1 text-xs text-ink-400">
                  <input
                    type="checkbox"
                    checked={e.enabled}
                    onChange={(ev) => setEntry(e.id, { enabled: ev.target.checked })}
                    className="h-3.5 w-3.5 accent-amber-500"
                  />
                  启用
                </label>
                <button
                  onClick={() => removeEntry(e.id)}
                  className="rounded p-1 text-ink-400 hover:text-red-400"
                  title="删除词条"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div>
                <label className={labelCls}>触发关键词（逗号分隔，留空=常驻）</label>
                <input
                  className={inputCls}
                  value={e.keys}
                  onChange={(ev) => setEntry(e.id, { keys: ev.target.value })}
                  placeholder="影阁, 杀手, 暗杀"
                />
              </div>
              <div>
                <label className={labelCls}>设定内容</label>
                <textarea
                  className={`${inputCls} min-h-20 resize-y`}
                  value={e.content}
                  onChange={(ev) => setEntry(e.id, { content: ev.target.value })}
                  placeholder="影阁是江湖第一杀手组织，阁主从不露面……"
                />
              </div>
            </div>
          ))}

          <button
            onClick={addEntry}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-ink-600 py-2 text-xs text-ink-300 hover:bg-ink-800"
          >
            <Plus size={14} /> 添加词条
          </button>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ink-700 px-5 py-4">
          {saved && <span className="text-xs text-emerald-400">已保存</span>}
          <button
            onClick={onClose}
            className="rounded-md border border-ink-600 px-4 py-1.5 text-sm text-ink-200 hover:bg-ink-700"
          >
            关闭
          </button>
          <button
            onClick={() => void save()}
            className="rounded-md bg-accent-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-500"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
