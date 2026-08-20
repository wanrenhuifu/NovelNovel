import { useRef, useState } from "react";
import { X, DatabaseBackup, Upload, Loader2 } from "lucide-react";
import { exportBackup, importBackup, type ImportSummary } from "../../lib/backup";

interface Props {
  onClose: () => void;
}

export function BackupModal({ onClose }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await exportBackup();
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const handleConfirmImport = async () => {
    if (!pendingFile) return;
    setImporting(true);
    setImportError(null);
    try {
      const summary = await importBackup(pendingFile);
      setImportResult(summary);
      // 全量替换了底层数据，刷新页面让所有 store 重新载入
      setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
      setPendingFile(null);
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = "";
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
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
          <h2 className="text-base font-semibold text-ink-100">备份与恢复</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-5 overflow-y-auto px-5 py-4">
          <section>
            <h3 className="mb-1.5 text-sm font-medium text-ink-200">导出备份</h3>
            <p className="mb-3 text-xs leading-relaxed text-ink-400">
              将全部作品、章节、角色卡与设置（含 API
              Key）打包为一个 JSON 文件。数据只存在于浏览器本地，建议定期导出备份。
            </p>
            <button
              onClick={() => void handleExport()}
              disabled={exporting}
              className="flex items-center gap-1.5 rounded-md bg-accent-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-500 disabled:opacity-50"
            >
              {exporting ? <Loader2 size={14} className="animate-spin" /> : <DatabaseBackup size={14} />}
              {exporting ? "打包中…" : "下载备份 JSON"}
            </button>
            {exportError && (
              <p className="mt-2 text-xs text-red-400">{exportError}</p>
            )}
          </section>

          <div className="border-t border-ink-800" />

          <section>
            <h3 className="mb-1.5 text-sm font-medium text-ink-200">导入备份</h3>
            {importResult ? (
              <p className="text-xs leading-relaxed text-emerald-400">
                已导入 {importResult.projects} 部作品、{importResult.chapters}{" "}
                个章节、{importResult.characters} 张角色卡，即将刷新页面…
              </p>
            ) : pendingFile ? (
              <div className="space-y-3 rounded-lg border border-ink-700 bg-ink-850/60 p-3">
                <p className="text-sm text-ink-100">{pendingFile.name}</p>
                <p className="text-xs leading-relaxed text-red-400">
                  导入将覆盖当前全部数据（作品、章节、角色卡、设置），且不可撤销。确认继续？
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => {
                      setPendingFile(null);
                      if (fileInput.current) fileInput.current.value = "";
                    }}
                    disabled={importing}
                    className="rounded-md border border-ink-600 px-4 py-1.5 text-sm text-ink-200 hover:bg-ink-700 disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => void handleConfirmImport()}
                    disabled={importing}
                    className="flex items-center gap-1.5 rounded-md bg-red-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
                  >
                    {importing && <Loader2 size={14} className="animate-spin" />}
                    {importing ? "导入中…" : "确认导入"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  onClick={() => fileInput.current?.click()}
                  className="flex items-center gap-1.5 rounded-md border border-ink-600 px-4 py-1.5 text-sm text-ink-200 hover:bg-ink-700"
                >
                  <Upload size={14} /> 选择备份文件
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={(e) => setPendingFile(e.target.files?.[0] ?? null)}
                />
              </>
            )}
            {importError && (
              <p className="mt-2 text-xs text-red-400">{importError}</p>
            )}
          </section>
        </div>

        <div className="flex justify-end border-t border-ink-700 px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-md border border-ink-600 px-4 py-1.5 text-sm text-ink-200 hover:bg-ink-700"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
