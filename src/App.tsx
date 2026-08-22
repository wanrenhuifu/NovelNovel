import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { FileText, Users, Loader2, ListTree } from "lucide-react";
import { TopBar } from "./components/layout/TopBar";
import { ChapterTree } from "./components/chapters/ChapterTree";
import { OutlinePanel } from "./components/outline/OutlinePanel";
import type { EditorHandle } from "./components/editor/Editor";
import { ChatPanel, type ChatPanelHandle } from "./components/chat/ChatPanel";
import { useProjectStore } from "./stores/project";
import { useSettingsStore } from "./stores/settings";
import { UnlockModal } from "./components/settings/UnlockModal";
import { useCharacterStore } from "./stores/characters";

// 编辑器（CodeMirror）、角色面板（char-card-reader）与设置弹窗按需加载，
// 首屏只保留应用骨架，大体积依赖在 IndexedDB 载入期间并行下载
const EditorPane = lazy(() =>
  import("./components/editor/EditorPane").then((m) => ({ default: m.EditorPane })),
);
const CharactersPanel = lazy(() =>
  import("./components/characters/CharactersPanel").then((m) => ({
    default: m.CharactersPanel,
  })),
);
const SettingsModal = lazy(() =>
  import("./components/settings/SettingsModal").then((m) => ({ default: m.SettingsModal })),
);

const PaneFallback = (
  <div className="flex h-full items-center justify-center gap-2 text-sm text-ink-400">
    <Loader2 size={15} className="animate-spin" /> 加载中…
  </div>
);

type LeftTab = "chapters" | "outline" | "characters";

export default function App() {
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const locked = useSettingsStore((s) => s.locked);
  const projectsLoaded = useProjectStore((s) => s.loaded);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const editorRef = useRef<EditorHandle>(null);
  const chatPanelRef = useRef<ChatPanelHandle>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [leftTab, setLeftTab] = useState<LeftTab>("chapters");

  useEffect(() => {
    void useSettingsStore.getState().load();
    void useProjectStore.getState().loadAll();
  }, []);

  useEffect(() => {
    if (activeProjectId != null) {
      void useCharacterStore.getState().loadForProject(activeProjectId);
    } else {
      useCharacterStore.getState().clear();
    }
  }, [activeProjectId]);

  if (!settingsLoaded || !projectsLoaded) {
    return (
      <div className="flex h-screen items-center justify-center gap-2 text-sm text-ink-400">
        <Loader2 size={16} className="animate-spin" /> 正在打开你的书房…
      </div>
    );
  }

  /** 搜索结果跳转：切章节后等编辑器重建完成（内容与 store 一致），再定位到命中位置 */
  const jumpToChapter = async (chapterId: number, pos: number | null) => {
    await useProjectStore.getState().setActiveChapter(chapterId);
    if (pos == null) return;
    const expected =
      useProjectStore.getState().chapters.find((c) => c.id === chapterId)?.content ?? "";
    for (let i = 0; i < 40; i++) {
      if (editorRef.current?.getContent() === expected) {
        editorRef.current.revealPos(pos);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar
        openAppSettings={() => setShowSettings(true)}
        jumpToChapter={jumpToChapter}
      />

      <div className="flex min-h-0 flex-1">
        {/* 左栏：章节 / 大纲 / 角色 */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-ink-800 bg-ink-900">
          <div className="flex border-b border-ink-800">
            <button
              onClick={() => setLeftTab("chapters")}
              className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors ${
                leftTab === "chapters"
                  ? "border-b-2 border-accent-500 text-ink-100"
                  : "text-ink-400 hover:text-ink-200"
              }`}
              title="章节管理"
            >
              <FileText size={13} /> 章节
            </button>
            <button
              onClick={() => setLeftTab("outline")}
              className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors ${
                leftTab === "outline"
                  ? "border-b-2 border-accent-500 text-ink-100"
                  : "text-ink-400 hover:text-ink-200"
              }`}
              title="全书大纲"
            >
              <ListTree size={13} /> 大纲
            </button>
            <button
              onClick={() => setLeftTab("characters")}
              className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors ${
                leftTab === "characters"
                  ? "border-b-2 border-accent-500 text-ink-100"
                  : "text-ink-400 hover:text-ink-200"
              }`}
              title="角色库"
            >
              <Users size={13} /> 角色
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {leftTab === "chapters" ? (
              <ChapterTree />
            ) : leftTab === "outline" ? (
              <OutlinePanel onJumpToChapter={(id) => void jumpToChapter(id, null)} />
            ) : (
              <Suspense fallback={PaneFallback}>
                <CharactersPanel />
              </Suspense>
            )}
          </div>
        </aside>

        {/* 中栏：编辑器 */}
        <main className="min-w-0 flex-1 bg-ink-950">
          <Suspense fallback={PaneFallback}>
            <EditorPane
              ref={editorRef}
              onRequestAiAction={(content) => chatPanelRef.current?.applyTemplate(content)}
            />
          </Suspense>
        </main>

        {/* 右栏：AI 助手 */}
        <aside className="flex w-96 shrink-0 flex-col border-l border-ink-800 bg-ink-900">
          <ChatPanel
            ref={chatPanelRef}
            getEditorContent={() => editorRef.current?.getContent() ?? ""}
            getSelection={() => editorRef.current?.getSelection() ?? ""}
            insertAtEnd={(text) => editorRef.current?.insertAtEnd(text)}
            replaceSelection={(text) => editorRef.current?.replaceSelection(text)}
            openSettings={() => setShowSettings(true)}
          />
        </aside>
      </div>

      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal onClose={() => setShowSettings(false)} />
        </Suspense>
      )}
      {locked && <UnlockModal />}
    </div>
  );
}
