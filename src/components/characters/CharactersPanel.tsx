import { useRef, useState } from "react";
import { Upload, Loader2, Users } from "lucide-react";
import { useCharacterStore } from "../../stores/characters";
import { useProjectStore } from "../../stores/project";
import { Avatar } from "../Avatar";
import { CharacterDetail } from "./CharacterDetail";
import type { Character, LoreEntry } from "../../types";

export function CharactersPanel() {
  const characters = useCharacterStore((s) => s.characters);
  const importFile = useCharacterStore((s) => s.importFile);
  const toggleActive = useCharacterStore((s) => s.toggleActive);
  const fileInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Character | null>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setImporting(true);
    setError(null);
    setNotice(null);
    const pendingLore: LoreEntry[] = [];
    for (const file of Array.from(files)) {
      try {
        const { loreEntries } = await importFile(file);
        pendingLore.push(...loreEntries);
      } catch (e) {
        setError(
          `「${file.name}」导入失败：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    // 世界书词条并入当前项目 lorebook；从 getState 取最新项目，避免用到过期快照
    if (pendingLore.length > 0) {
      const { projects, activeProjectId, updateProject } =
        useProjectStore.getState();
      const project = projects.find((p) => p.id === activeProjectId);
      if (project?.id != null) {
        await updateProject(project.id, {
          lorebook: [...(project.lorebook ?? []), ...pendingLore],
        });
        setNotice(`已将 ${pendingLore.length} 条世界书设定并入世界观 Lorebook`);
      }
    }
    setImporting(false);
    if (fileInput.current) fileInput.current.value = "";
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">
          <Users size={13} /> 角色卡
        </span>
        <button
          onClick={() => fileInput.current?.click()}
          disabled={importing}
          className="flex items-center gap-1 rounded-md bg-accent-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-accent-500 disabled:opacity-50"
        >
          {importing ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
          导入
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".png,.json,.webp,.jpg,.jpeg,image/*,application/json"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {error && (
        <div className="mx-3 mb-2 rounded-md border border-red-900 bg-red-950/40 px-2.5 py-2 text-xs leading-relaxed text-red-300">
          {error}
        </div>
      )}

      {notice && (
        <div className="mx-3 mb-2 rounded-md border border-emerald-900 bg-emerald-950/40 px-2.5 py-2 text-xs leading-relaxed text-emerald-300">
          {notice}
        </div>
      )}

      <div className="flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        {characters.length === 0 && (
          <div className="px-2 py-6 text-center text-xs leading-relaxed text-ink-400">
            暂无角色。
            <br />
            支持导入 SillyTavern 角色卡（PNG / JSON）。
          </div>
        )}
        {characters.map((c) => (
          <div
            key={c.id}
            className="group flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-ink-800"
            onClick={() => setSelected(c)}
            title="点击查看详情"
          >
            <Avatar blob={c.avatar} size={34} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-ink-100">{c.name}</div>
              <div className="truncate text-[11px] text-ink-400">
                {c.specVersion.toUpperCase()}
                {c.lorebookCount > 0 ? ` · 世界书 ${c.lorebookCount}` : ""}
              </div>
            </div>
            <label
              className="flex items-center gap-1.5 text-[11px] text-ink-400"
              onClick={(e) => e.stopPropagation()}
              title={c.active ? "已参与 AI 写作，点击取消" : "未参与 AI 写作，点击启用"}
            >
              <input
                type="checkbox"
                checked={c.active}
                onChange={() => toggleActive(c.id!)}
                className="h-3.5 w-3.5 accent-amber-500"
              />
              参与
            </label>
          </div>
        ))}
      </div>

      {selected && (
        <CharacterDetail character={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
