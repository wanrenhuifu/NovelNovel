import { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  Send,
  Square,
  PenLine,
  ClipboardPaste,
  Bot,
  Settings2,
  RefreshCw,
} from "lucide-react";
import { useActiveProject } from "../../stores/project";
import { useCharacterStore } from "../../stores/characters";
import {
  useSettingsStore,
  useActiveProvider,
  useActivePreset,
} from "../../stores/settings";
import { generateStream, type ChatMessage } from "../../lib/ai";
import {
  buildSystemPrompt,
  buildContinueUserMessage,
} from "../../lib/prompt";
import { db } from "../../lib/db";
import { uid } from "../../lib/utils";
import type { ChatMessageStored } from "../../types";

interface Props {
  getEditorContent: () => string;
  insertAtEnd: (text: string) => void;
  replaceSelection: (text: string) => void;
  openSettings: () => void;
}

/** 续写哨兵：userText 等于它时，消息内容在组装请求时用最新正文重建 */
const CONTINUE_SENTINEL = buildContinueUserMessage("", "");

export function ChatPanel({
  getEditorContent,
  insertAtEnd,
  replaceSelection,
  openSettings,
}: Props) {
  const project = useActiveProject();
  const characters = useCharacterStore((s) => s.characters);
  const settings = useSettingsStore((s) => s.settings);
  const provider = useActiveProvider();
  const preset = useActivePreset();

  const [entries, setEntries] = useState<ChatMessageStored[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; waitMs: number } | null>(null);
  const abortRef = useRef<{ abort: () => void } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 切换项目时载入该项目的历史会话
  useEffect(() => {
    setError(null);
    if (project?.id == null) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    void db.chatSessions.get(project.id).then((session) => {
      if (!cancelled) setEntries(session?.messages ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries]);

  const persist = (messages: ChatMessageStored[]) => {
    const projectId = project?.id;
    if (projectId == null) return;
    void db.chatSessions.put({ projectId, messages });
  };

  const activeCharacters = characters.filter((c) => c.active);

  /** 取编辑器尾部正文作为续写上下文 */
  const recentText = () => {
    const content = getEditorContent();
    const limit = settings?.contextChars ?? 3000;
    return content.length > limit ? content.slice(-limit) : content;
  };

  /** 会话里存的 userText；续写消息在发请求时按最新正文重建 */
  const messageContent = (e: ChatMessageStored, recent: string): string =>
    e.userText === CONTINUE_SENTINEL
      ? buildContinueUserMessage(recent, "")
      : e.content;

  const run = async (userText: string, history: ChatMessageStored[]) => {
    if (!project) {
      setError("请先创建并选择一个小说项目");
      return;
    }
    if (!provider) {
      setError("请先在设置中配置 AI 服务商");
      return;
    }
    setError(null);
    const userEntry: ChatMessageStored = {
      id: uid(),
      role: "user",
      content: userText,
      userText,
    };
    const assistantEntry: ChatMessageStored = {
      id: uid(),
      role: "assistant",
      content: "",
    };
    const newHistory = [...history, userEntry];
    setEntries([...newHistory, assistantEntry]);
    persist([...newHistory, assistantEntry]);
    setStreaming(true);

    const recent = recentText();
    const systemPrompt = buildSystemPrompt(
      project,
      activeCharacters,
      recent,
      preset,
    );
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...newHistory.map((e) => ({
        role: e.role,
        content: messageContent(e, recent),
      })),
    ];

    const controller = new AbortController();
    abortRef.current = controller;
    let acc = "";
    try {
      await generateStream(
        provider,
        messages,
        {
          temperature: settings?.temperature ?? 0.85,
          maxTokens: settings?.maxTokens ?? 1000,
        },
        {
          signal: controller.signal,
          onToken(token) {
            acc += token;
            setEntries((prev) =>
              prev.map((e) => (e.id === assistantEntry.id ? { ...e, content: acc } : e)),
            );
          },
          onRetry({ attempt, waitMs }) {
            setRetryInfo({ attempt, waitMs });
          },
        },
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      // 流结束（完成/中断/出错）后把最终内容落库
      persist([...newHistory, { ...assistantEntry, content: acc }]);
      setStreaming(false);
      setRetryInfo(null);
      abortRef.current = null;
    }
  };

  const handleContinue = () => {
    if (!project) {
      setError("请先创建并选择一个小说项目");
      return;
    }
    void run(CONTINUE_SENTINEL, entries);
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    void run(text, entries);
  };

  const handleRegenerate = (assistantId: string) => {
    if (streaming) return;
    const idx = entries.findIndex((e) => e.id === assistantId);
    if (idx < 0) return;
    const historyBefore = entries.slice(0, idx);
    const lastUser = [...historyBefore].reverse().find((e) => e.role === "user");
    if (!lastUser) return;
    void run(
      lastUser.userText ?? lastUser.content,
      historyBefore.filter((e) => e.id !== lastUser.id),
    );
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const lastAssistantId = [...entries]
    .reverse()
    .find((e) => e.role === "assistant")?.id;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-ink-800 px-3 py-2.5">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">
          <Bot size={13} /> AI 助手
        </span>
        <div className="flex items-center gap-2">
          {provider ? (
            <span className="max-w-[120px] truncate text-[11px] text-ink-400" title={provider.modelId}>
              {provider.name}
            </span>
          ) : (
            <span className="text-[11px] text-red-400">未配置</span>
          )}
          <button
            onClick={openSettings}
            className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
            title="设置"
          >
            <Settings2 size={14} />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {entries.length === 0 && (
          <div className="px-2 py-8 text-center text-xs leading-relaxed text-ink-400">
            点击“续写”让 AI 接着当前章节往下写，
            <br />
            或直接输入指令（如“把上一段改得更有张力”）。
            <br />
            <br />
            已参与写作的角色：
            {activeCharacters.length > 0
              ? activeCharacters.map((c) => c.name).join("、")
              : "无（在角色库勾选）"}
          </div>
        )}
        {entries.map((e) => (
          <div key={e.id}>
            <div
              className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-sm leading-relaxed ${
                e.role === "user"
                  ? "ml-6 bg-ink-800 text-ink-100"
                  : "mr-2 border border-ink-700 bg-ink-850 text-ink-200"
              }`}
            >
              {e.role === "user" && e.userText === CONTINUE_SENTINEL
                ? "（续写本章）"
                : e.content || (streaming ? "…" : "")}
            </div>
            {e.role === "assistant" && e.content && !streaming && (
              <div className="mt-1 flex justify-end gap-1">
                {e.id === lastAssistantId && (
                  <button
                    onClick={() => handleRegenerate(e.id)}
                    className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-ink-400 hover:bg-ink-800 hover:text-accent-400"
                    title="按上一条指令重新生成"
                  >
                    <RefreshCw size={12} /> 重新生成
                  </button>
                )}
                <button
                  onClick={() => insertAtEnd(e.content)}
                  className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-ink-400 hover:bg-ink-800 hover:text-accent-400"
                  title="追加到当前章节末尾"
                >
                  <ClipboardPaste size={12} /> 插入末尾
                </button>
                <button
                  onClick={() => replaceSelection(e.content)}
                  className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-ink-400 hover:bg-ink-800 hover:text-accent-400"
                  title="替换编辑器选区（无选区则插入到光标处）"
                >
                  <PenLine size={12} /> 替换选区
                </button>
              </div>
            )}
          </div>
        ))}
        {streaming && retryInfo && (
          <div className="rounded-md border border-amber-800 bg-amber-950/40 px-2.5 py-2 text-xs leading-relaxed text-amber-300">
            请求失败，正在自动重试（第 {retryInfo.attempt} 次，约{" "}
            {Math.max(1, Math.round(retryInfo.waitMs / 1000))} 秒后）…点“停止”可取消
          </div>
        )}
        {error && (
          <div className="rounded-md border border-red-900 bg-red-950/40 px-2.5 py-2 text-xs leading-relaxed text-red-300">
            {error}
          </div>
        )}
      </div>

      <div className="border-t border-ink-800 p-3">
        <div className="mb-2 flex gap-2">
          <button
            onClick={handleContinue}
            disabled={streaming || !project}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-accent-600 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-500 disabled:opacity-40"
          >
            <Sparkles size={15} /> 续写本章
          </button>
          {streaming && (
            <button
              onClick={handleStop}
              className="flex items-center justify-center gap-1 rounded-md border border-red-800 px-3 text-sm text-red-300 hover:bg-red-950/40"
            >
              <Square size={13} /> 停止
            </button>
          )}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            rows={2}
            placeholder="输入写作指令，Enter 发送…"
            className="flex-1 resize-none rounded-md border border-ink-700 bg-ink-850 px-2.5 py-2 text-sm text-ink-100 outline-none placeholder:text-ink-600 focus:border-accent-500"
          />
          <button
            onClick={handleSend}
            disabled={streaming || !input.trim()}
            className="rounded-md bg-ink-700 p-2.5 text-ink-100 hover:bg-ink-600 disabled:opacity-40"
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
