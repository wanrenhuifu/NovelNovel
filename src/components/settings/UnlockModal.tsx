import { useState } from "react";
import { Lock, AlertCircle } from "lucide-react";
import { useSettingsStore } from "../../stores/settings";

/**
 * 启动时的解锁弹窗：当 API Key 处于加密状态且本轮尚未输入主密码时全屏显示。
 * 解锁失败会在输入框下方显示红色提示。
 */
export function UnlockModal() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const unlock = useSettingsStore((s) => s.unlock);

  const handleSubmit = async () => {
    if (!password) return;
    setLoading(true);
    setError(null);
    const result = await unlock(password);
    setLoading(false);
    if (!result.ok) {
      setError(result.error ?? "解锁失败");
      return;
    }
    setPassword("");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/90 backdrop-blur-sm">
      <div className="w-[380px] rounded-xl border border-ink-700 bg-ink-900 p-6 shadow-2xl">
        <div className="mb-4 flex items-center gap-2">
          <Lock className="text-accent-400" size={18} />
          <h2 className="text-sm font-semibold text-ink-100">已启用加密锁</h2>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-ink-400">
          API Key 已加密保存。请输入主密码以解锁本轮会话；刷新页面后需要重新输入。
        </p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSubmit();
          }}
          placeholder="主密码"
          className="mb-2 w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-100 outline-none placeholder:text-ink-600 focus:border-accent-500"
        />
        {error && (
          <div className="mb-2 flex items-center gap-1.5 text-xs text-red-400">
            <AlertCircle size={13} /> {error}
          </div>
        )}
        <button
          onClick={() => void handleSubmit()}
          disabled={!password || loading}
          className="mt-1 w-full rounded-md bg-accent-600 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-500 disabled:opacity-50"
        >
          {loading ? "解锁中…" : "解锁"}
        </button>
      </div>
    </div>
  );
}
