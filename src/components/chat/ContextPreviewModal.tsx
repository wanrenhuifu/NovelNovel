import { useState } from "react";
import { X, Copy, Check } from "lucide-react";

interface Section {
  title: string;
  content: string;
  meta?: string;
}

interface Props {
  sections: Section[];
  onClose: () => void;
}

/**
 * 上下文预览弹窗：显示本次请求注入 AI 的完整内容（system / lorebook / 前文 / 历史）。
 * 用于调试提示词与上下文组装。
 */
export function ContextPreviewModal({ sections, onClose }: Props) {
  const [copied, setCopied] = useState<string | null>(null);

  const copySection = async (title: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = content;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(title);
    setTimeout(() => setCopied((cur) => (cur === title ? null : cur)), 1500);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
          <h2 className="text-base font-semibold text-ink-100">上下文预览</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
          >
            <X size={18} />
          </button>
        </div>

        <p className="border-b border-ink-800 px-5 py-2 text-xs text-ink-400">
          以下是本次请求注入 AI 的完整内容。每段右侧的复制按钮可单独拷贝用于外部调试。
        </p>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {sections.map((s) => (
            <section key={s.title} className="rounded-lg border border-ink-800 bg-ink-950/50">
              <div className="flex items-center justify-between border-b border-ink-800 px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-ink-200">{s.title}</span>
                  {s.meta && <span className="text-[11px] text-ink-500">{s.meta}</span>}
                </div>
                <button
                  onClick={() => void copySection(s.title, s.content)}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-400 hover:bg-ink-800 hover:text-ink-100"
                  title="复制此段"
                >
                  {copied === s.title ? (
                    <>
                      <Check size={11} /> 已复制
                    </>
                  ) : (
                    <>
                      <Copy size={11} /> 复制
                    </>
                  )}
                </button>
              </div>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-300">
                {s.content || <span className="text-ink-600">（空）</span>}
              </pre>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
