import { useState } from "react";
import { X, Download, Loader2 } from "lucide-react";
import type { Project } from "../../types";
import { exportNovel } from "../../lib/export";

interface Props {
  project: Project;
  chapterCount: number;
  onClose: () => void;
}

export function ExportModal({ project, chapterCount, onClose }: Props) {
  const [format, setFormat] = useState<"md" | "txt">("md");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doExport = async () => {
    setBusy(true);
    setError(null);
    try {
      await exportNovel(project, format);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-700 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-100">导出全书</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
          >
            <X size={16} />
          </button>
        </div>
        <div className="space-y-3 px-4 py-4">
          <p className="text-xs text-ink-400">
            《{project.title}》共 {chapterCount} 章，按章节顺序合并导出。
          </p>
          <div className="flex gap-2">
            {(
              [
                { key: "md", label: "Markdown（.md）" },
                { key: "txt", label: "纯文本（.txt）" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.key}
                onClick={() => setFormat(opt.key)}
                className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
                  format === opt.key
                    ? "border-accent-500 bg-accent-600/20 text-accent-400"
                    : "border-ink-600 text-ink-300 hover:bg-ink-800"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-ink-700 px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-ink-600 px-3.5 py-1.5 text-sm text-ink-200 hover:bg-ink-700"
          >
            取消
          </button>
          <button
            onClick={() => void doExport()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-md bg-accent-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-accent-500 disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            导出
          </button>
        </div>
      </div>
    </div>
  );
}
