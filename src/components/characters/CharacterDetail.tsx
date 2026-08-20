import { useState } from "react";
import { X, Trash2, Download } from "lucide-react";
import type { Character } from "../../types";
import { Avatar } from "../Avatar";
import { useCharacterStore } from "../../stores/characters";
import { exportCharacterPng } from "../../lib/export";

interface Props {
  character: Character;
  onClose: () => void;
}

function Field({ label, value }: { label: string; value: string }) {
  if (!value.trim()) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-accent-400">{label}</div>
      <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-ink-850 p-2.5 text-sm leading-relaxed text-ink-200">
        {value}
      </div>
    </div>
  );
}

export function CharacterDetail({ character, onClose }: Props) {
  const remove = useCharacterStore((s) => s.remove);
  const [confirming, setConfirming] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    await remove(character.id!);
    onClose();
  };

  const handleExportPng = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await exportCharacterPng(character);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-ink-700 p-4">
          <Avatar blob={character.avatar} size={56} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-lg font-semibold text-ink-100">
              {character.name}
            </div>
            <div className="mt-0.5 text-xs text-ink-400">
              规格 {character.specVersion.toUpperCase()}
              {character.creator ? ` · 作者 ${character.creator}` : ""}
              {character.lorebookCount > 0
                ? ` · 世界书 ${character.lorebookCount} 条`
                : ""}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <Field label="角色描述" value={character.description} />
          <Field label="性格" value={character.personality} />
          <Field label="情境" value={character.scenario} />
          <Field label="开场白" value={character.firstMes} />
          <Field label="对话示例" value={character.mesExample} />
          <Field label="创作者备注" value={character.creatorNotes} />
        </div>

        <div className="flex items-center justify-between border-t border-ink-700 p-4">
          <button
            onClick={handleDelete}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
              confirming
                ? "bg-red-600 text-white"
                : "text-red-400 hover:bg-red-950/50"
            }`}
          >
            <Trash2 size={15} />
            {confirming ? "确认删除？" : "删除角色"}
          </button>
          <div className="flex items-center gap-2">
            {exportError && (
              <span className="text-xs text-red-400">{exportError}</span>
            )}
            <button
              onClick={() => void handleExportPng()}
              disabled={exporting}
              className="flex items-center gap-1.5 rounded-md border border-ink-600 px-3 py-1.5 text-sm text-ink-200 hover:bg-ink-700 disabled:opacity-50"
              title="按 SillyTavern 规范重新内嵌角色数据并下载 PNG"
            >
              <Download size={15} />
              {exporting ? "导出中…" : "导出 PNG"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
