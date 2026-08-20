import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { Project } from "../../types";
import { useProjectStore } from "../../stores/project";

interface Props {
  project: Project;
  onClose: () => void;
}

const inputCls =
  "w-full rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-sm text-ink-100 outline-none placeholder:text-ink-600 focus:border-accent-500";
const labelCls = "mb-1 block text-xs text-ink-400";

export function ProjectSettingsModal({ project, onClose }: Props) {
  const updateProject = useProjectStore((s) => s.updateProject);
  const [title, setTitle] = useState(project.title);
  const [synopsis, setSynopsis] = useState(project.synopsis);
  const [worldbuilding, setWorldbuilding] = useState(project.worldbuilding);
  const [authorNote, setAuthorNote] = useState(project.authorNote);

  useEffect(() => {
    setTitle(project.title);
    setSynopsis(project.synopsis);
    setWorldbuilding(project.worldbuilding);
    setAuthorNote(project.authorNote);
  }, [project]);

  const save = async () => {
    await updateProject(project.id!, {
      title: title.trim() || "未命名小说",
      synopsis,
      worldbuilding,
      authorNote,
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl border border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
          <h2 className="text-base font-semibold text-ink-100">作品设定</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <label className={labelCls}>书名</label>
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>作品简介</label>
            <textarea
              className={`${inputCls} min-h-20 resize-y`}
              value={synopsis}
              onChange={(e) => setSynopsis(e.target.value)}
              placeholder="一句话或一段话概括这部作品"
            />
          </div>
          <div>
            <label className={labelCls}>世界观与背景（注入 AI 提示词）</label>
            <textarea
              className={`${inputCls} min-h-32 resize-y font-serif`}
              value={worldbuilding}
              onChange={(e) => setWorldbuilding(e.target.value)}
              placeholder="时代背景、地理、势力、力量体系……AI 写作时会参考这些设定"
            />
          </div>
          <div>
            <label className={labelCls}>写作要求（注入 AI 提示词）</label>
            <textarea
              className={`${inputCls} min-h-24 resize-y`}
              value={authorNote}
              onChange={(e) => setAuthorNote(e.target.value)}
              placeholder="文风、叙事视角、禁忌、节奏等要求，如：第三人称限知视角，文笔冷峻克制"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-ink-700 px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-md border border-ink-600 px-4 py-1.5 text-sm text-ink-200 hover:bg-ink-700"
          >
            取消
          </button>
          <button
            onClick={save}
            className="rounded-md bg-accent-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-500"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
