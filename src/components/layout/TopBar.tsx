import { lazy, Suspense, useState } from "react";
import { Feather, Plus, Trash2, BookOpenText, Settings, Download, BookMarked, DatabaseBackup, Search } from "lucide-react";
import { useProjectStore, useActiveProject } from "../../stores/project";
import { ProjectSettingsModal } from "../projects/ProjectSettingsModal";
import { NewProjectModal } from "../projects/NewProjectModal";
import { ExportModal } from "../projects/ExportModal";
import { LorebookModal } from "../projects/LorebookModal";

// 按需加载：备份内含全量数据序列化，搜索仅在打开时需要
const BackupModal = lazy(() =>
  import("../projects/BackupModal").then((m) => ({ default: m.BackupModal })),
);
const SearchModal = lazy(() =>
  import("../projects/SearchModal").then((m) => ({ default: m.SearchModal })),
);

interface Props {
  openAppSettings: () => void;
  /** 搜索命中后跳转到章节并定位正文位置 */
  jumpToChapter: (chapterId: number, pos: number | null) => void;
}

export function TopBar({ openAppSettings, jumpToChapter }: Props) {
  const projects = useProjectStore((s) => s.projects);
  const chapters = useProjectStore((s) => s.chapters);
  const activeProject = useActiveProject();
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const createProject = useProjectStore((s) => s.createProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showLorebook, setShowLorebook] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleNew = async (title: string) => {
    await createProject(title || "未命名小说");
  };

  const handleDelete = async () => {
    if (!activeProject) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await deleteProject(activeProject.id!);
    setConfirmDelete(false);
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-ink-800 bg-ink-900 px-4">
      <div className="flex items-center gap-2 text-accent-400">
        <Feather size={18} />
        <span className="text-sm font-bold tracking-wide text-ink-100">NovelNovel</span>
      </div>

      <div className="mx-2 h-5 w-px bg-ink-700" />

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <select
          value={activeProject?.id ?? ""}
          onChange={(e) => setActiveProject(e.target.value ? Number(e.target.value) : null)}
          className="max-w-64 min-w-0 truncate rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-sm text-ink-100 outline-none focus:border-accent-500"
        >
          {projects.length === 0 && <option value="">（暂无作品）</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <button
          onClick={() => setShowNewProject(true)}
          className="flex items-center gap-1 rounded-md border border-ink-600 px-2.5 py-1.5 text-xs text-ink-200 hover:bg-ink-700"
          title="新建小说"
        >
          <Plus size={14} /> 新建
        </button>
        {activeProject && (
          <>
            <button
              onClick={() => setShowProjectSettings(true)}
              className="flex items-center gap-1 rounded-md border border-ink-600 px-2.5 py-1.5 text-xs text-ink-200 hover:bg-ink-700"
              title="作品设定（简介 / 世界观 / 写作要求）"
            >
              <BookOpenText size={14} /> 作品设定
            </button>
            <button
              onClick={() => setShowLorebook(true)}
              className="flex items-center gap-1 rounded-md border border-ink-600 px-2.5 py-1.5 text-xs text-ink-200 hover:bg-ink-700"
              title="世界观 Lorebook（设定词条，按关键词注入 AI）"
            >
              <BookMarked size={14} /> Lorebook
            </button>
            <button
              onClick={() => setShowSearch(true)}
              className="flex items-center gap-1 rounded-md border border-ink-600 px-2.5 py-1.5 text-xs text-ink-200 hover:bg-ink-700"
              title="全文搜索章节标题与正文"
            >
              <Search size={14} /> 搜索
            </button>
            <button
              onClick={() => setShowExport(true)}
              className="flex items-center gap-1 rounded-md border border-ink-600 px-2.5 py-1.5 text-xs text-ink-200 hover:bg-ink-700"
              title="导出全书为 Markdown / TXT"
            >
              <Download size={14} /> 导出
            </button>
            <button
              onClick={() => setShowBackup(true)}
              className="flex items-center gap-1 rounded-md border border-ink-600 px-2.5 py-1.5 text-xs text-ink-200 hover:bg-ink-700"
              title="备份与恢复全部数据（JSON）"
            >
              <DatabaseBackup size={14} /> 备份
            </button>
            <button
              onClick={handleDelete}
              onBlur={() => setConfirmDelete(false)}
              className={`flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                confirmDelete
                  ? "border-red-700 bg-red-950/60 text-red-300"
                  : "border-ink-600 text-ink-400 hover:bg-ink-700 hover:text-red-400"
              }`}
              title="删除本书（含全部章节与角色）"
            >
              <Trash2 size={14} /> {confirmDelete ? "确认删除？" : ""}
            </button>
          </>
        )}
      </div>

      <button
        onClick={openAppSettings}
        className="flex items-center gap-1.5 rounded-md border border-ink-600 px-2.5 py-1.5 text-xs text-ink-200 hover:bg-ink-700"
        title="AI 服务商与生成参数"
      >
        <Settings size={14} /> 设置
      </button>

      {showProjectSettings && activeProject && (
        <ProjectSettingsModal
          project={activeProject}
          onClose={() => setShowProjectSettings(false)}
        />
      )}
      {showNewProject && (
        <NewProjectModal
          onCreate={handleNew}
          onClose={() => setShowNewProject(false)}
        />
      )}
      {showExport && activeProject && (
        <ExportModal
          project={activeProject}
          chapters={chapters}
          onClose={() => setShowExport(false)}
        />
      )}
      {showLorebook && activeProject && (
        <LorebookModal
          project={activeProject}
          onClose={() => setShowLorebook(false)}
        />
      )}
      {showBackup && (
        <Suspense fallback={null}>
          <BackupModal onClose={() => setShowBackup(false)} />
        </Suspense>
      )}
      {showSearch && activeProject && (
        <Suspense fallback={null}>
          <SearchModal
            onClose={() => setShowSearch(false)}
            onJump={jumpToChapter}
          />
        </Suspense>
      )}
    </header>
  );
}
