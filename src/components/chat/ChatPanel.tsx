import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  Sparkles,
  Send,
  Square,
  PenLine,
  ClipboardPaste,
  Bot,
  Settings2,
  RefreshCw,
  Eraser,
  Copy,
  Check,
  Eye,
  Repeat,
} from "lucide-react";
import { useActiveProject, useProjectStore } from "../../stores/project";
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
  trimChatHistory,
  type PrevChapterExcerpt,
} from "../../lib/prompt";
import { db } from "../../lib/db";
import { uid } from "../../lib/utils";
import type { ChatMessageStored } from "../../types";
import { ContextPreviewModal } from "./ContextPreviewModal";

interface Props {
  getEditorContent: () => string;
  /** 获取编辑器当前选区文本（无选区返回空串） */
  getSelection: () => string;
  insertAtEnd: (text: string) => void;
  replaceSelection: (text: string) => void;
  openSettings: () => void;
}

export interface ChatPanelHandle {
  /** 触发一个指令模板（由编辑器右键菜单调用） */
  applyTemplate: (content: string) => void;
}

/** 续写哨兵：userText 等于它时，消息内容在组装请求时用最新正文重建 */
const CONTINUE_SENTINEL = buildContinueUserMessage("", "");

export const ChatPanel = forwardRef<ChatPanelHandle, Props>(function ChatPanel(
  {
    getEditorContent,
    getSelection,
    insertAtEnd,
    replaceSelection,
    openSettings,
  },
  ref,
) {
  const project = useActiveProject();
  const chapters = useProjectStore((s) => s.chapters);
  const activeChapterId = useProjectStore((s) => s.activeChapterId);
  const characters = useCharacterStore((s) => s.characters);
  const settings = useSettingsStore((s) => s.settings);
  const provider = useActiveProvider();
  const preset = useActivePreset();

  const [entries, setEntries] = useState<ChatMessageStored[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; waitMs: number } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [autoActive, setAutoActive] = useState(false);
  const [autoCountdown, setAutoCountdown] = useState<number | null>(null);
  const abortRef = useRef<{ abort: () => void } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 自动续写：finally 需要读最新 active 标志，state 更新是异步的所以用 ref 同步
  const autoActiveRef = useRef(false);
  const autoRunTimerRef = useRef<number | null>(null);
  const autoCountdownTimerRef = useRef<number | null>(null);

  // 同步 ref 与 state，保证 finally 能读到最新值
  useEffect(() => {
    autoActiveRef.current = autoActive;
  }, [autoActive]);

  // 切换项目或章节时停止自动续写（上下文已变，不应继续上一轮循环）
  useEffect(() => {
    return () => {
      clearAutoTimers();
    };
  }, [project?.id, activeChapterId]);

  // 切换项目时载入该项目的历史会话
  useEffect(() => {
    setError(null);
    stopAutoContinue();
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

  /** 清理自动续写的两个定时器 */
  const clearAutoTimers = () => {
    if (autoRunTimerRef.current != null) {
      window.clearTimeout(autoRunTimerRef.current);
      autoRunTimerRef.current = null;
    }
    if (autoCountdownTimerRef.current != null) {
      window.clearInterval(autoCountdownTimerRef.current);
      autoCountdownTimerRef.current = null;
    }
    setAutoCountdown(null);
  };

  /** 启动下一轮自动续写的倒计时 */
  const scheduleAutoContinue = () => {
    if (!autoActiveRef.current) return;
    const interval = settings?.autoContinueIntervalMs ?? 5000;
    const seconds = Math.max(1, Math.round(interval / 1000));
    setAutoCountdown(seconds);
    // 每秒递减，便于用户看到下一轮何时触发
    autoCountdownTimerRef.current = window.setInterval(() => {
      setAutoCountdown((cur) => {
        if (cur == null) return null;
        return cur <= 1 ? 0 : cur - 1;
      });
    }, 1000);
    autoRunTimerRef.current = window.setTimeout(() => {
      clearAutoTimers();
      // 用最新的 entries 触发续写（通过函数式 setState 读最新）
      setEntries((cur) => {
        // 仅触发副作用，不实际更新 entries
        void run(CONTINUE_SENTINEL, cur);
        return cur;
      });
    }, interval);
  };

  /** 停止自动续写（清定时器 + 置 inactive） */
  const stopAutoContinue = () => {
    clearAutoTimers();
    autoActiveRef.current = false;
    setAutoActive(false);
  };

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

  /** 当前章节之前若干章的尾部摘录，按章节顺序由远及近 */
  const prevExcerpts = (): PrevChapterExcerpt[] => {
    const count = settings?.prevChapterCount ?? 0;
    const limit = settings?.prevChapterChars ?? 1500;
    if (!count || count <= 0 || activeChapterId == null) return [];
    const idx = chapters.findIndex((c) => c.id === activeChapterId);
    if (idx <= 0) return [];
    return chapters
      .slice(Math.max(0, idx - count), idx)
      .map((c) => ({
        title: c.title,
        text: c.content.length > limit ? c.content.slice(-limit) : c.content,
      }))
      .filter((c) => c.text.trim());
  };

  /** 会话里存的 userText；续写消息在发请求时按最新正文与前文重建 */
  const messageContent = (
    e: ChatMessageStored,
    recent: string,
    prev: PrevChapterExcerpt[],
  ): string =>
    e.userText === CONTINUE_SENTINEL
      ? buildContinueUserMessage(recent, "", prev)
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
    const prev = prevExcerpts();
    // 前文也参与 lorebook 关键词匹配，前几章提到的设定同样会被激活
    const contextText = [...prev.map((c) => c.text), recent].join("\n");
    const systemPrompt = buildSystemPrompt(
      project,
      activeCharacters,
      contextText,
      preset,
    );
    // 只截断发给 API 的历史；界面与落库仍保留完整会话
    const sentHistory = trimChatHistory(newHistory, settings?.chatContextTurns ?? 0);
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...sentHistory.map((e) => ({
        role: e.role,
        content: messageContent(e, recent, prev),
      })),
    ];

    const controller = new AbortController();
    abortRef.current = controller;
    let acc = "";
    // 跟踪本轮是否成功完成（无错误 + 非用户中断）；自动续写据此决定是否触发下一轮
    let success = false;
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
      success = true;
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
      // 自动续写只在“成功完成”时触发下一轮；出错或用户中断都停在这里
      if (autoActiveRef.current && success) {
        scheduleAutoContinue();
      } else if (!success) {
        stopAutoContinue();
      }
    }
  };

  /** 构造上下文预览数据（与 run 使用同一组装逻辑，但不发送） */
  const buildContextSections = () => {
    if (!project || !provider) return [];
    const recent = recentText();
    const prev = prevExcerpts();
    const contextText = [...prev.map((c) => c.text), recent].join("\n");
    const systemPrompt = buildSystemPrompt(project, activeCharacters, contextText, preset);
    const sentHistory = trimChatHistory(entries, settings?.chatContextTurns ?? 0);

    const sections: { title: string; content: string; meta?: string }[] = [];
    sections.push({
      title: "系统提示词",
      content: systemPrompt,
      meta: `${systemPrompt.length} 字符`,
    });
    if (prev.length > 0) {
      sections.push({
        title: "前文摘录",
        content: prev.map((p) => `### ${p.title}\n${p.text}`).join("\n\n"),
        meta: `${prev.length} 章`,
      });
    }
    sections.push({
      title: "当前章尾部正文",
      content: recent || "（空）",
      meta: `${recent.length} 字符`,
    });
    sections.push({
      title: "对话历史（将发送）",
      content: sentHistory
        .map((e) => `[${e.role}]\n${messageContent(e, recent, prev)}`)
        .join("\n\n"),
      meta: `${sentHistory.length} 条`,
    });
    return sections;
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
    // 用户主动发新指令：打断自动续写循环
    stopAutoContinue();
    void run(text, entries);
  };

  const handleRegenerate = (assistantId: string) => {
    if (streaming) return;
    const idx = entries.findIndex((e) => e.id === assistantId);
    if (idx < 0) return;
    const historyBefore = entries.slice(0, idx);
    const lastUser = [...historyBefore].reverse().find((e) => e.role === "user");
    if (!lastUser) return;
    stopAutoContinue();
    void run(
      lastUser.userText ?? lastUser.content,
      historyBefore.filter((e) => e.id !== lastUser.id),
    );
  };

  const handleStop = () => {
    abortRef.current?.abort();
    stopAutoContinue();
  };

  /** 切换自动续写开关：开启后在流结束时自动排下一轮；关闭则清掉所有定时 */
  const toggleAutoContinue = () => {
    if (autoActive) {
      stopAutoContinue();
      return;
    }
    if (!project || !provider) {
      setError("请先选择项目并配置 AI 服务商");
      return;
    }
    autoActiveRef.current = true;
    setAutoActive(true);
    // 如果当前不在 streaming，立即启动第一轮等待
    if (!streaming) {
      scheduleAutoContinue();
    }
  };

  const handleClear = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    setEntries([]);
    setError(null);
    stopAutoContinue();
    const projectId = project?.id;
    if (projectId != null) void db.chatSessions.delete(projectId);
  };

  const handleCopy = (id: string, content: string) => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    });
  };

  /** 应用快速指令模板：{{selection}} 替换为编辑器选区；无选区且模板依赖选区时只填入输入框 */
  const applyTemplate = (content: string) => {
    if (streaming) return;
    if (!content.includes("{{selection}}")) {
      void run(content, entries);
      return;
    }
    const selection = getSelection().trim();
    if (selection) {
      void run(content.replace(/\{\{selection\}\}/g, selection), entries);
    } else {
      setInput(content.replace(/\{\{selection\}\}/g, ""));
      setError("模板需要选中文本：先在编辑器里选中要处理的段落，或补充输入框内容");
    }
  };

  // applyTemplate 依赖闭包里的 streaming/entries/input，用 ref 暴露最新函数避免 handle 过期
  const applyTemplateRef = useRef(applyTemplate);
  applyTemplateRef.current = applyTemplate;
  useImperativeHandle(
    ref,
    () => ({
      applyTemplate: (content: string) => applyTemplateRef.current(content),
    }),
    [],
  );

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
          {entries.length > 0 && !streaming && (
            <button
              onClick={handleClear}
              onBlur={() => setConfirmClear(false)}
              className={`flex items-center gap-1 rounded p-1 text-[11px] transition-colors ${
                confirmClear
                  ? "bg-red-950/60 text-red-300"
                  : "text-ink-400 hover:bg-ink-700 hover:text-red-400"
              }`}
              title="清空本作品的全部对话记录"
            >
              <Eraser size={13} /> {confirmClear ? "确认清空？" : ""}
            </button>
          )}
          <button
            onClick={toggleAutoContinue}
            className={`flex items-center gap-1 rounded p-1 text-[11px] transition-colors ${
              autoActive
                ? "bg-amber-950/50 text-amber-300 hover:bg-amber-900/50"
                : "text-ink-400 hover:bg-ink-700 hover:text-ink-100"
            }`}
            title={autoActive ? "自动续写已开启，点击关闭" : "自动续写：完成后每隔 N 秒自动再续写一次"}
          >
            <Repeat size={14} className={autoActive ? "animate-pulse" : ""} />
            {autoActive && autoCountdown != null ? `${autoCountdown}s` : ""}
          </button>
          <button
            onClick={() => setShowContext(true)}
            className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
            title="查看本次请求注入 AI 的完整上下文"
          >
            <Eye size={14} />
          </button>
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
                  onClick={() => handleCopy(e.id, e.content)}
                  className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] ${
                    copiedId === e.id
                      ? "text-emerald-400"
                      : "text-ink-400 hover:bg-ink-800 hover:text-accent-400"
                  }`}
                  title="复制回复内容"
                >
                  {copiedId === e.id ? <Check size={12} /> : <Copy size={12} />}
                  {copiedId === e.id ? "已复制" : "复制"}
                </button>
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
        {(settings?.instructionTemplates?.length ?? 0) > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {settings!.instructionTemplates.map((t) => (
              <button
                key={t.id}
                onClick={() => applyTemplate(t.content)}
                disabled={streaming}
                title={t.content}
                className="rounded-full border border-ink-600 px-2.5 py-0.5 text-[11px] text-ink-300 transition-colors hover:border-accent-500 hover:text-accent-400 disabled:opacity-40"
              >
                {t.name}
              </button>
            ))}
          </div>
        )}
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

      {showContext && (
        <ContextPreviewModal
          sections={buildContextSections()}
          onClose={() => setShowContext(false)}
        />
      )}
    </div>
  );
});
