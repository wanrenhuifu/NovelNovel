import { useState } from "react";
import { X } from "lucide-react";

interface Props {
  onCreate: (title: string) => Promise<void>;
  onClose: () => void;
}

export function NewProjectModal({ onCreate, onClose }: Props) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onCreate(title);
      onClose();
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
          <h2 className="text-sm font-semibold text-ink-100">新建小说</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-4">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") onClose();
            }}
            placeholder="书名，如：长安落雪"
            className="w-full rounded-md border border-ink-700 bg-ink-850 px-2.5 py-2 text-sm text-ink-100 outline-none placeholder:text-ink-600 focus:border-accent-500"
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-ink-700 px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-ink-600 px-3.5 py-1.5 text-sm text-ink-200 hover:bg-ink-700"
          >
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="rounded-md bg-accent-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-accent-500 disabled:opacity-50"
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
