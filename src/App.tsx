import { useEffect, useRef, useState } from "react";
import { FileText, Users, Loader2 } from "lucide-react";
import { TopBar } from "./components/layout/TopBar";
import { ChapterTree } from "./components/chapters/ChapterTree";
import { CharactersPanel } from "./components/characters/CharactersPanel";
import { EditorPane } from "./components/editor/EditorPane";
import type { EditorHandle } from "./components/editor/Editor";
import { ChatPanel } from "./components/chat/ChatPanel";
import { SettingsModal } from "./components/settings/SettingsModal";
import { useProjectStore } from "./stores/project";
import { useSettingsStore } from "./stores/settings";
import { useCharacterStore } from "./stores/characters";

type LeftTab = "chapters" | "characters";

export default function App() {
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const projectsLoaded = useProjectStore((s) => s.loaded);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const editorRef = useRef<EditorHandle>(null);
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

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar openAppSettings={() => setShowSettings(true)} />

      <div className="flex min-h-0 flex-1">
        {/* 左栏：章节 / 角色 */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-ink-800 bg-ink-900">
          <div className="flex border-b border-ink-800">
            <button
              onClick={() => setLeftTab("chapters")}
              className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors ${
                leftTab === "chapters"
                  ? "border-b-2 border-accent-500 text-ink-100"
                  : "text-ink-400 hover:text-ink-200"
              }`}
            >
              <FileText size={13} /> 章节
            </button>
            <button
              onClick={() => setLeftTab("characters")}
              className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors ${
                leftTab === "characters"
                  ? "border-b-2 border-accent-500 text-ink-100"
                  : "text-ink-400 hover:text-ink-200"
              }`}
            >
              <Users size={13} /> 角色
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {leftTab === "chapters" ? <ChapterTree /> : <CharactersPanel />}
          </div>
        </aside>

        {/* 中栏：编辑器 */}
        <main className="min-w-0 flex-1 bg-ink-950">
          <EditorPane ref={editorRef} />
        </main>

        {/* 右栏：AI 助手 */}
        <aside className="flex w-96 shrink-0 flex-col border-l border-ink-800 bg-ink-900">
          <ChatPanel
            getEditorContent={() => editorRef.current?.getContent() ?? ""}
            insertAtEnd={(text) => editorRef.current?.insertAtEnd(text)}
            replaceSelection={(text) => editorRef.current?.replaceSelection(text)}
            openSettings={() => setShowSettings(true)}
          />
        </aside>
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
