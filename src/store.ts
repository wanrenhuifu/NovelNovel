/**
 * NovelStore：小说数据在文件系统上的读写。
 *
 * 字段语义沿用领域层（src/domain/types.ts），存储形式换成工作区文件：
 * 字符串 id、一章一个 .md、一张卡一个 .json + 图片头像文件。
 * 提示词组装/搜索/排序/导出等纯逻辑直接复用 src/domain，不在这里重写。
 */
import type { LoreEntry, Preset } from "./domain/types";
import { parseCharacterBytes } from "./domain/cardImport";
import { buildCharacterPng, buildNovelDocument, safeName } from "./domain/export";
import { parsePresetFile } from "./domain/presetImport";
import { computeReorder } from "./domain/reorder";
import { searchChapters, type SearchMatch } from "./domain/search";
import { countWords, uid } from "./domain/utils";
import type { Context, ToolRunContext } from "./contract";
import { FsOps, type FsSession } from "./fsx";
import {
  WORKSPACE_VERSION,
  type Chapter,
  type ChapterIndex,
  type ChapterMeta,
  type NovelProject,
  type PresetFile,
  type StoredCharacter,
  type WorkspaceFile,
} from "./types";

export interface NovelConfig {
  /** 数据根目录（相对工作目录） */
  dataDir: string;
  defaultPrevChapterCount: number;
  defaultPrevChapterChars: number;
  defaultRecentChars: number;
}

export interface ProjectSummary {
  project: NovelProject;
  chapterCount: number;
  words: number;
  active: boolean;
}

/** 读不出 project.json 的作品目录（损坏或被外部改写）：跳过而不是让整个插件失败 */
export interface UnreadableProject {
  /** 目录名 */
  id: string;
  error: string;
}

/** 解析作品引用所需的最小信息（不含章节统计，读一条作品只花 2 次文件读取） */
export interface ProjectRef {
  id: string;
  title: string;
  createdAt: number;
  active: boolean;
}

export interface ProjectRefListing {
  projects: ProjectRef[];
  unreadable: UnreadableProject[];
  /** workspace.json 读不出来时的原因（不致命，但会影响「当前作品」） */
  workspaceError?: string;
}

export interface ProjectListing {
  projects: ProjectSummary[];
  unreadable: UnreadableProject[];
  /** workspace.json 读不出来时的原因（不是致命错误，但会影响「当前作品」） */
  workspaceError?: string;
}

export interface ImportedCharacterResult {
  character: StoredCharacter;
  /** 从卡内世界书并入项目 lorebook 的词条数（已去重） */
  mergedLoreEntries: number;
  /** 因与现有词条重复而跳过的数量 */
  skippedLoreEntries: number;
}

export interface ExportResult {
  /** 相对工作目录的路径（给模型/用户展示用） */
  path: string;
  bytes: number;
  chapters: number;
  words: number;
}

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  apng: "image/apng",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  json: "application/json",
};

function mediaTypeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MEDIA_TYPES[ext] ?? "";
}

/** 头像落盘用的扩展名：媒体类型 → 扩展名，未知类型按 PNG（嵌卡只认 PNG，非 PNG 头像再导出时会退回占位图） */
function extensionForMediaType(mediaType: string): string {
  const normalized = mediaType.toLowerCase();
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("apng")) return "apng";
  return "png";
}

function isDestructiveConfirmed(value: boolean | undefined): boolean {
  return value === true;
}

export class NovelStore {
  private readonly ops: FsOps;

  constructor(
    ctx: Context,
    private readonly config: NovelConfig,
  ) {
    this.ops = new FsOps(ctx);
  }

  /** 由工具执行上下文得到文件会话（工作目录 + 取消信号 + 沙箱策略） */
  sessionOf(exec: ToolRunContext): FsSession {
    return this.ops.sessionOf(exec);
  }

  /** 由命令处理器等没有 exec 的场景构造文件会话 */
  sessionFor(
    session: { readonly header: { readonly cwd?: string } } | undefined,
    signal?: AbortSignal,
  ): FsSession {
    return this.ops.sessionFor(session, signal);
  }

  /** 读工作区外的文本文件（预设/卡片导入用），文件不存在即报错 */
  async readTextFile(path: string, session: FsSession): Promise<string> {
    return this.ops.readText(path, session);
  }

  // ── 路径 ──────────────────────────────────────────────────────────────

  private root(): string {
    return this.config.dataDir;
  }

  private projectsRoot(): string {
    return `${this.root()}/projects`;
  }

  private projectDir(id: string): string {
    return `${this.projectsRoot()}/${id}`;
  }

  /** 作品数据目录（相对工作目录），用于给用户/模型展示 */
  projectPath(id: string): string {
    return this.projectDir(id);
  }

  private projectFile(id: string): string {
    return `${this.projectDir(id)}/project.json`;
  }

  private lorebookFile(id: string): string {
    return `${this.projectDir(id)}/lorebook.json`;
  }

  private presetsFile(id: string): string {
    return `${this.projectDir(id)}/presets.json`;
  }

  private chapterIndexFile(id: string): string {
    return `${this.projectDir(id)}/chapters/index.json`;
  }

  private chapterFile(id: string, chapterId: string): string {
    return `${this.projectDir(id)}/chapters/${chapterId}.md`;
  }

  private charactersDir(id: string): string {
    return `${this.projectDir(id)}/characters`;
  }

  private characterFile(id: string, characterId: string): string {
    return `${this.charactersDir(id)}/${characterId}.json`;
  }

  /** 头像文件路径：文件名取自角色记录（扩展名与真实媒体类型一致） */
  private characterAvatarPath(projectId: string, avatarFile: string): string {
    return `${this.charactersDir(projectId)}/${avatarFile}`;
  }

  private exportsDir(id: string): string {
    return `${this.projectDir(id)}/exports`;
  }

  // ── 工作区状态 ────────────────────────────────────────────────────────

  /**
   * 读取工作区状态。
   * workspace.json 读不出来时（损坏/被改成非 JSON）不抛错——否则所有工具都会失效——
   * 但要记下来，交给 resolveProjectId 决定是否必须显式指定作品，避免悄悄写错作品。
   */
  private async readWorkspace(
    session: FsSession,
  ): Promise<{ file: WorkspaceFile; error?: string }> {
    try {
      const file = await this.ops.readJson<WorkspaceFile>(
        `${this.root()}/workspace.json`,
        session,
      );
      return { file: file ?? { version: WORKSPACE_VERSION, activeProject: null } };
    } catch (error: unknown) {
      return {
        file: { version: WORKSPACE_VERSION, activeProject: null },
        error: (error as Error).message,
      };
    }
  }

  private async writeWorkspace(session: FsSession, file: WorkspaceFile): Promise<void> {
    await this.ops.writeJson(`${this.root()}/workspace.json`, file, session);
  }

  async setActiveProject(session: FsSession, projectId: string): Promise<void> {
    const { file } = await this.readWorkspace(session);
    file.activeProject = projectId;
    await this.writeWorkspace(session, file);
  }

  // ── 作品 ──────────────────────────────────────────────────────────────

  /**
   * 遍历作品目录并逐个读取。
   * 单个作品目录读不出来（project.json 损坏、被外部改成非 JSON 等）时跳过并记录，
   * 不让一个坏目录把整个插件的入口都堵死——否则 list / 解析当前作品全都会失败。
   * `read` 里抛错同样算作该目录不可读。
   */
  private async scanProjectDirs<T>(
    session: FsSession,
    read: (project: NovelProject, dir: string, active: string | null) => Promise<T>,
  ): Promise<{ items: T[]; unreadable: UnreadableProject[]; active: string | null; workspaceError?: string }> {
    const workspace = await this.readWorkspace(session);
    const active = workspace.file.activeProject;
    const entries = await this.ops.listDir(this.projectsRoot(), session);
    const items: T[] = [];
    const unreadable: UnreadableProject[] = [];
    for (const entry of entries) {
      if (entry.type !== "directory") continue;
      try {
        const project = await this.ops.readJson<NovelProject>(
          this.projectFile(entry.name),
          session,
        );
        if (!project) continue;
        items.push(await read(project, entry.name, active));
      } catch (error: unknown) {
        unreadable.push({ id: entry.name, error: (error as Error).message });
      }
    }
    return {
      items,
      unreadable,
      active,
      ...(workspace.error ? { workspaceError: workspace.error } : {}),
    };
  }

  /**
   * 解析作品引用所需的最小信息。
   * 只读 project.json + chapters/index.json——解析引用不需要章节正文，
   * 而统计字数要读遍全书，那条路径只留给列表展示（listProjects）。
   */
  async listProjectRefs(session: FsSession): Promise<ProjectRefListing> {
    const scan = await this.scanProjectDirs<ProjectRef>(session, async (project, dir, active) => {
      // 读一次索引：与 listProjects 保持同一套「坏目录」判定口径（索引损坏同样算不可读）
      await this.listChapterMetas(session, dir);
      return {
        id: project.id,
        title: project.title,
        createdAt: project.createdAt,
        active: dir === active,
      };
    });
    return {
      projects: scan.items.sort((a, b) => a.createdAt - b.createdAt),
      unreadable: scan.unreadable,
      ...(scan.workspaceError ? { workspaceError: scan.workspaceError } : {}),
    };
  }

  /** 列出全部作品（含章节数与总字数，供列表展示；解析引用请用 listProjectRefs） */
  async listProjects(session: FsSession): Promise<ProjectListing> {
    const scan = await this.scanProjectDirs<ProjectSummary>(session, async (project, dir, active) => {
      // 一趟读到章节正文，同时得出章节数与总字数（不再重复读索引）
      const chapters = await this.listChapters(session, dir);
      return {
        project,
        chapterCount: chapters.length,
        words: chapters.reduce((sum, chapter) => sum + chapter.words, 0),
        active: dir === active,
      };
    });
    return {
      projects: scan.items.sort((a, b) => a.project.createdAt - b.project.createdAt),
      unreadable: scan.unreadable,
      ...(scan.workspaceError ? { workspaceError: scan.workspaceError } : {}),
    };
  }

  /**
   * 解析作品引用：id / 标题（可部分匹配）/ 序号；缺省用当前作品。
   *
   * 缺省且当前作品不可用（没设过、或 workspace.json 损坏）时：只有一个作品才自动选中，
   * 有多个作品则要求显式指定——否则会把正文悄悄写进错误的作品里。
   */
  async resolveProjectId(session: FsSession, ref?: string): Promise<string> {
    const { projects, unreadable, workspaceError } = await this.listProjectRefs(session);
    if (projects.length === 0) {
      throw new Error(
        unreadable.length > 0
          ? `no readable novel project: ${unreadable
              .map((item) => `${item.id} (${item.error})`)
              .join(", ")} — fix or remove those directories under ${this.projectsRoot()}`
          : "no novel project yet — create one with novel_project action=create",
      );
    }
    const wanted = ref?.trim();
    if (!wanted) {
      const current = projects.find((p) => p.active);
      if (current) return current.id;
      if (projects.length === 1) return projects[0].id;
      throw new Error(
        `no current project: pass project=<id> explicitly. Available: ${projects
          .map((p) => `${p.id} (${p.title})`)
          .join(", ")}` +
          (workspaceError
            ? `. The workspace pointer is unreadable (${workspaceError}); repair ${this.root()}/workspace.json or pick one with novel_project action=use`
            : ". Pick one with novel_project action=use"),
      );
    }
    const lower = wanted.toLowerCase();
    const exact = projects.find((p) => p.id === wanted || p.title.toLowerCase() === lower);
    if (exact) return exact.id;
    const asIndex = Number(wanted);
    if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= projects.length) {
      return projects[asIndex - 1].id;
    }
    const partial = projects.filter((p) => p.title.toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0].id;
    throw new Error(
      `project "${wanted}" not found or ambiguous. Available: ${projects
        .map((p) => `${p.id} (${p.title})`)
        .join(", ")}` +
        (unreadable.length > 0
          ? `. Unreadable project directories: ${unreadable.map((item) => item.id).join(", ")}`
          : ""),
    );
  }

  async readProject(session: FsSession, projectId: string): Promise<NovelProject> {
    const project = await this.ops.readJson<NovelProject>(this.projectFile(projectId), session);
    if (!project) throw new Error(`project not found: ${projectId} (check the project id)`);
    return project;
  }

  private async slugForTitle(session: FsSession, title: string): Promise<string> {
    const base =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "novel";
    const entries = await this.ops.listDir(this.projectsRoot(), session);
    const taken = new Set(entries.map((entry) => entry.name));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new Error(`cannot allocate a project directory for title "${title}"`);
  }

  async createProject(
    session: FsSession,
    input: { title: string; synopsis?: string; worldbuilding?: string; authorNote?: string },
  ): Promise<NovelProject> {
    const title = input.title.trim();
    if (!title) throw new Error("project title is required");
    const id = await this.slugForTitle(session, title);
    const now = Date.now();
    const project: NovelProject = {
      id,
      title,
      synopsis: input.synopsis?.trim() ?? "",
      worldbuilding: input.worldbuilding?.trim() ?? "",
      authorNote: input.authorNote?.trim() ?? "",
      createdAt: now,
      updatedAt: now,
    };
    await this.ops.writeJson(this.projectFile(id), project, session);
    await this.ops.writeJson(this.lorebookFile(id), [], session);
    await this.ops.writeJson(
      this.presetsFile(id),
      { activePresetId: null, presets: [] } satisfies PresetFile,
      session,
    );
    await this.ops.writeJson(
      this.chapterIndexFile(id),
      { items: [] } satisfies ChapterIndex,
      session,
    );
    await this.setActiveProject(session, id);
    return project;
  }

  async updateProject(
    session: FsSession,
    projectId: string,
    patch: Partial<Pick<NovelProject, "title" | "synopsis" | "worldbuilding" | "authorNote">>,
  ): Promise<NovelProject> {
    const project = await this.readProject(session, projectId);
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new Error("project title cannot be empty");
      project.title = title;
    }
    if (patch.synopsis !== undefined) project.synopsis = patch.synopsis;
    if (patch.worldbuilding !== undefined) project.worldbuilding = patch.worldbuilding;
    if (patch.authorNote !== undefined) project.authorNote = patch.authorNote;
    project.updatedAt = Date.now();
    await this.ops.writeJson(this.projectFile(projectId), project, session);
    return project;
  }

  async deleteProject(
    session: FsSession,
    projectId: string,
    confirm: boolean | undefined,
  ): Promise<void> {
    if (!isDestructiveConfirmed(confirm)) {
      throw new Error(
        "refusing to delete a project without confirm=true — confirm with the user first",
      );
    }
    // 必须先确认这是已解析出的作品目录，避免把任意目录名删掉
    await this.readProject(session, projectId);
    await this.ops.removeDir(this.projectDir(projectId), session);
    const { file } = await this.readWorkspace(session);
    if (file.activeProject === projectId) {
      file.activeProject = null;
      await this.writeWorkspace(session, file);
    }
  }

  // ── 世界观词条 ────────────────────────────────────────────────────────

  async readLorebook(session: FsSession, projectId: string): Promise<LoreEntry[]> {
    return (await this.ops.readJson<LoreEntry[]>(this.lorebookFile(projectId), session)) ?? [];
  }

  private async writeLorebook(
    session: FsSession,
    projectId: string,
    entries: LoreEntry[],
  ): Promise<void> {
    await this.ops.writeJson(this.lorebookFile(projectId), entries, session);
  }

  async addLoreEntries(
    session: FsSession,
    projectId: string,
    entries: Omit<LoreEntry, "id">[],
  ): Promise<{ added: number; skipped: number; total: number }> {
    const current = await this.readLorebook(session, projectId);
    const seen = new Set(current.map((e) => `${e.name}\u0000${e.content.trim()}`));
    let added = 0;
    let skipped = 0;
    for (const entry of entries) {
      const key = `${entry.name}\u0000${entry.content.trim()}`;
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      current.push({ ...entry, id: uid() });
      added++;
    }
    if (added > 0) await this.writeLorebook(session, projectId, current);
    return { added, skipped, total: current.length };
  }

  async updateLoreEntry(
    session: FsSession,
    projectId: string,
    ref: string,
    patch: { name?: string; keys?: string; content?: string; enabled?: boolean; toggle?: boolean },
  ): Promise<LoreEntry> {
    const entries = await this.readLorebook(session, projectId);
    const entry = this.findLoreEntry(entries, ref, projectId);
    if (patch.name !== undefined) entry.name = patch.name;
    if (patch.keys !== undefined) entry.keys = patch.keys;
    if (patch.content !== undefined) entry.content = patch.content;
    if (patch.enabled !== undefined) entry.enabled = patch.enabled;
    // toggle 在解析出唯一词条之后再翻转，避免部分匹配时读到错误的前值
    if (patch.toggle === true) entry.enabled = !entry.enabled;
    await this.writeLorebook(session, projectId, entries);
    return entry;
  }

  async removeLoreEntry(session: FsSession, projectId: string, ref: string): Promise<LoreEntry> {
    const entries = await this.readLorebook(session, projectId);
    const entry = this.findLoreEntry(entries, ref, projectId);
    await this.writeLorebook(
      session,
      projectId,
      entries.filter((e) => e.id !== entry.id),
    );
    return entry;
  }

  /**
   * 解析词条引用：id / 名称精确 / 名称部分匹配。
   * 与章节一样给出候选清单，便于模型自我纠正。
   */
  private findLoreEntry(entries: LoreEntry[], ref: string, projectId: string): LoreEntry {
    const wanted = ref.trim();
    const lower = wanted.toLowerCase();
    const exact = entries.find((e) => e.id === wanted || e.name.toLowerCase() === lower);
    if (exact) return exact;
    const partial = entries.filter((e) => e.name.toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    if (entries.length === 0) throw new Error(`project "${projectId}" has no lorebook entries yet`);
    throw new Error(
      partial.length > 1
        ? `lorebook entry "${ref}" is ambiguous: ${partial.map((e) => e.name).join(", ")}`
        : `lorebook entry "${ref}" not found. Available: ${entries.map((e) => e.name).join(", ")}`,
    );
  }

  // ── 写作预设 ──────────────────────────────────────────────────────────

  async readPresets(session: FsSession, projectId: string): Promise<PresetFile> {
    return (
      (await this.ops.readJson<PresetFile>(this.presetsFile(projectId), session)) ?? {
        activePresetId: null,
        presets: [],
      }
    );
  }

  private async writePresets(
    session: FsSession,
    projectId: string,
    file: PresetFile,
  ): Promise<void> {
    await this.ops.writeJson(this.presetsFile(projectId), file, session);
  }

  /** 从 JSON 文本导入预设（识别裸预设与合订信封，见 presetImport.ts） */
  async importPreset(
    session: FsSession,
    projectId: string,
    text: string,
  ): Promise<{ preset: Preset; note?: string; activated: boolean; replacedActive: boolean }> {
    const { preset, note } = parsePresetFile(text);
    const file = await this.readPresets(session, projectId);
    const existing = file.presets.findIndex((p) => p.name === preset.name);
    // 同名重导入是替换：必须沿用原 id，否则 activePresetId 会指向已删除的 id，
    // 表现为「列表里显示有激活项，但组装简报时静默退回内置默认提示词」。
    const replacedId = existing >= 0 ? file.presets[existing].id : null;
    const stored: Preset = { ...preset, id: replacedId ?? uid(), createdAt: Date.now() };
    if (existing >= 0) file.presets[existing] = stored;
    else file.presets.push(stored);
    let activated = false;
    // 首个可用预设自动激活：instruct 只存档，不参与提示词组装
    if (stored.kind !== "instruct" && file.activePresetId === null) {
      file.activePresetId = stored.id;
      activated = true;
    }
    const replacedActive = replacedId !== null && file.activePresetId === replacedId;
    await this.writePresets(session, projectId, file);
    return { preset: stored, ...(note ? { note } : {}), activated, replacedActive };
  }

  async addPreset(
    session: FsSession,
    projectId: string,
    input: { name: string; systemPrompt?: string; storyString?: string },
  ): Promise<{ preset: Preset; activated: boolean }> {
    const name = input.name.trim();
    if (!name) throw new Error("preset name is required");
    const file = await this.readPresets(session, projectId);
    const preset: Preset = {
      id: uid(),
      name,
      systemPrompt: input.systemPrompt ?? "",
      storyString: input.storyString ?? "",
      kind: input.storyString ? "context" : "system",
      createdAt: Date.now(),
    };
    file.presets.push(preset);
    // 首个预设自动激活：否则用户会以为已经生效
    const activated = file.activePresetId === null;
    if (activated) file.activePresetId = preset.id;
    await this.writePresets(session, projectId, file);
    return { preset, activated };
  }

  /** 解析预设引用：id / 名称精确 / 名称唯一部分匹配（与章节、角色卡的解析口径一致） */
  async resolvePreset(session: FsSession, projectId: string, ref: string): Promise<Preset> {
    const file = await this.readPresets(session, projectId);
    const all = file.presets;
    const wanted = ref.trim();
    const exact = all.find(
      (preset) => preset.id === wanted || preset.name.toLowerCase() === wanted.toLowerCase(),
    );
    if (exact) return exact;
    const partial = all.filter((preset) =>
      preset.name.toLowerCase().includes(wanted.toLowerCase()),
    );
    if (partial.length === 1) return partial[0];
    if (all.length === 0) {
      throw new Error(`project "${projectId}" has no presets yet — import one first`);
    }
    throw new Error(
      partial.length > 1
        ? `preset "${ref}" is ambiguous: ${partial.map((preset) => preset.name).join(", ")}`
        : `preset "${ref}" not found. Available: ${all
            .map((preset) => `${preset.id} (${preset.name})`)
            .join(", ")}`,
    );
  }

  async updatePreset(
    session: FsSession,
    projectId: string,
    presetId: string,
    patch: { name?: string; systemPrompt?: string; storyString?: string },
  ): Promise<Preset> {
    const file = await this.readPresets(session, projectId);
    const preset = file.presets.find((p) => p.id === presetId);
    if (!preset) throw new Error(`preset not found: ${presetId}`);
    if (patch.name !== undefined) preset.name = patch.name.trim() || preset.name;
    if (patch.systemPrompt !== undefined) preset.systemPrompt = patch.systemPrompt;
    if (patch.storyString !== undefined) preset.storyString = patch.storyString;
    await this.writePresets(session, projectId, file);
    return preset;
  }

  /**
   * 激活/停用预设。传 null 表示停用（回到内置默认）。
   * 只接受已解析出的 presetId——引用解析统一走 resolvePreset。
   */
  async activatePreset(
    session: FsSession,
    projectId: string,
    presetId: string | null,
  ): Promise<PresetFile> {
    const file = await this.readPresets(session, projectId);
    if (presetId === null) {
      file.activePresetId = null;
      await this.writePresets(session, projectId, file);
      return file;
    }
    const preset = file.presets.find((p) => p.id === presetId);
    if (!preset) throw new Error(`preset not found: ${presetId}`);
    if (preset.kind === "instruct") {
      throw new Error(
        `preset "${preset.name}" is an instruct preset: it only controls dialogue formatting, ` +
          `which the harness owns, so it is archived but never applied`,
      );
    }
    file.activePresetId = preset.id;
    await this.writePresets(session, projectId, file);
    return file;
  }

  async removePreset(session: FsSession, projectId: string, presetId: string): Promise<Preset> {
    const file = await this.readPresets(session, projectId);
    const preset = file.presets.find((p) => p.id === presetId);
    if (!preset) throw new Error(`preset not found: ${presetId}`);
    file.presets = file.presets.filter((p) => p.id !== presetId);
    if (file.activePresetId === presetId) file.activePresetId = null;
    await this.writePresets(session, projectId, file);
    return preset;
  }

  /** 当前参与提示词组装的预设（instruct 不参与，未激活时为 null） */
  activePreset(file: PresetFile): Preset | null {
    if (!file.activePresetId) return null;
    const preset = file.presets.find((p) => p.id === file.activePresetId) ?? null;
    return preset && preset.kind !== "instruct" ? preset : null;
  }

  // ── 章节 ──────────────────────────────────────────────────────────────

  private async readChapterIndex(session: FsSession, projectId: string): Promise<ChapterIndex> {
    return (
      (await this.ops.readJson<ChapterIndex>(this.chapterIndexFile(projectId), session)) ?? {
        items: [],
      }
    );
  }

  private async writeChapterIndex(
    session: FsSession,
    projectId: string,
    index: ChapterIndex,
  ): Promise<void> {
    await this.ops.writeJson(this.chapterIndexFile(projectId), index, session);
  }

  async listChapterMetas(session: FsSession, projectId: string): Promise<ChapterMeta[]> {
    const index = await this.readChapterIndex(session, projectId);
    return [...index.items].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /** 章节列表（带正文与字数）：正文以文件为准，agent 直接改文件也能反映出来 */
  async listChapters(session: FsSession, projectId: string): Promise<Chapter[]> {
    const metas = await this.listChapterMetas(session, projectId);
    const chapters: Chapter[] = [];
    for (const meta of metas) {
      const content = (await this.ops.readTextOrNull(this.chapterFile(projectId, meta.id), session)) ?? "";
      chapters.push({ ...meta, content, words: countWords(content) });
    }
    return chapters;
  }

  /** 解析章节引用：id / 第N章 / 标题精确 / 标题唯一部分匹配 */
  async resolveChapterId(
    session: FsSession,
    projectId: string,
    ref: string,
  ): Promise<ChapterMeta> {
    const items = await this.listChapterMetas(session, projectId);
    if (items.length === 0) {
      throw new Error(`project "${projectId}" has no chapters yet — create one first`);
    }
    const wanted = ref.trim();
    const byId = items.find((m) => m.id === wanted);
    if (byId) return byId;
    if (/^\s*(第)?\d+(章|节|话|回)?\s*$/.test(wanted)) {
      const n = Number(wanted.replace(/\D/g, ""));
      if (n >= 1 && n <= items.length) return items[n - 1];
    }
    const lower = wanted.toLowerCase();
    const byTitle = items.find((m) => m.title.toLowerCase() === lower);
    if (byTitle) return byTitle;
    const partial = items.filter((m) => m.title.toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    throw new Error(
      partial.length > 1
        ? `chapter "${ref}" is ambiguous: ${partial.map((m) => m.title).join(", ")}`
        : `chapter "${ref}" not found. Available: ${items
            .map((m, i) => `${i + 1}. ${m.title} (${m.id})`)
            .join(", ")}`,
    );
  }

  async readChapter(session: FsSession, projectId: string, ref: string): Promise<Chapter> {
    const meta = await this.resolveChapterId(session, projectId, ref);
    const content =
      (await this.ops.readTextOrNull(this.chapterFile(projectId, meta.id), session)) ?? "";
    return { ...meta, content, words: countWords(content) };
  }

  async createChapter(
    session: FsSession,
    projectId: string,
    input: { title: string; content?: string; tags?: string[]; position?: number },
  ): Promise<Chapter> {
    const title = input.title.trim();
    if (!title) throw new Error("chapter title is required");
    const index = await this.readChapterIndex(session, projectId);
    const id = uid().replace(/-/g, "").slice(0, 10);
    const position =
      input.position === undefined || input.position < 1
        ? index.items.length + 1
        : Math.min(input.position, index.items.length + 1);
    index.items.splice(position - 1, 0, {
      id,
      title,
      tags: input.tags ?? [],
      sortOrder: position - 1,
      updatedAt: Date.now(),
    });
    index.items = index.items.map((item, i) => ({ ...item, sortOrder: i }));
    const content = input.content ?? "";
    await this.ops.writeText(this.chapterFile(projectId, id), content, session);
    await this.writeChapterIndex(session, projectId, index);
    return { ...index.items[position - 1], content, words: countWords(content) };
  }

  private async patchChapter(
    session: FsSession,
    projectId: string,
    chapterId: string,
    patch: (meta: ChapterMeta) => void,
  ): Promise<ChapterMeta> {
    const index = await this.readChapterIndex(session, projectId);
    const meta = index.items.find((item) => item.id === chapterId);
    if (!meta) throw new Error(`chapter not found: ${chapterId}`);
    patch(meta);
    meta.updatedAt = Date.now();
    await this.writeChapterIndex(session, projectId, index);
    return meta;
  }

  /** 覆写章节正文 */
  async writeChapterBody(
    session: FsSession,
    projectId: string,
    chapterId: string,
    content: string,
  ): Promise<Chapter> {
    const meta = await this.patchChapter(session, projectId, chapterId, () => {});
    await this.ops.writeText(this.chapterFile(projectId, chapterId), content, session);
    return { ...meta, content, words: countWords(content) };
  }

  /** 追加正文（续写的落地写入口） */
  async appendChapterBody(
    session: FsSession,
    projectId: string,
    chapterId: string,
    text: string,
  ): Promise<Chapter> {
    const current =
      (await this.ops.readTextOrNull(this.chapterFile(projectId, chapterId), session)) ?? "";
    const joined = current.replace(/\s*$/, "") + (current.trim() ? "\n\n" : "") + text.trim() + "\n";
    return this.writeChapterBody(session, projectId, chapterId, joined);
  }

  async updateChapterMeta(
    session: FsSession,
    projectId: string,
    chapterId: string,
    patch: { title?: string; tags?: string[]; addTags?: string[]; removeTags?: string[] },
  ): Promise<ChapterMeta> {
    return this.patchChapter(session, projectId, chapterId, (meta) => {
      if (patch.title !== undefined) {
        const title = patch.title.trim();
        if (!title) throw new Error("chapter title cannot be empty");
        meta.title = title;
      }
      if (patch.tags !== undefined) meta.tags = patch.tags;
      if (patch.addTags !== undefined) {
        meta.tags = [...new Set([...meta.tags, ...patch.addTags])];
      }
      if (patch.removeTags !== undefined) {
        const drop = new Set(patch.removeTags);
        meta.tags = meta.tags.filter((tag) => !drop.has(tag));
      }
    });
  }

  /** 移动章节：复用 domain/reorder.ts 的排序语义（sortOrder 归一化为 0..n-1） */
  async moveChapter(
    session: FsSession,
    projectId: string,
    chapterId: string,
    targetId: string,
    position: "before" | "after",
  ): Promise<ChapterMeta[]> {
    const items = await this.listChapterMetas(session, projectId);
    const reordered = computeReorder(items, chapterId, targetId, position);
    if (!reordered) return items;
    await this.writeChapterIndex(session, projectId, { items: reordered });
    return reordered;
  }

  async deleteChapter(
    session: FsSession,
    projectId: string,
    chapterId: string,
    confirm: boolean | undefined,
  ): Promise<ChapterMeta> {
    if (!isDestructiveConfirmed(confirm)) {
      throw new Error(
        "refusing to delete a chapter without confirm=true — confirm with the user first",
      );
    }
    const index = await this.readChapterIndex(session, projectId);
    const meta = index.items.find((item) => item.id === chapterId);
    if (!meta) throw new Error(`chapter not found: ${chapterId}`);
    index.items = index.items
      .filter((item) => item.id !== chapterId)
      .map((item, i) => ({ ...item, sortOrder: i }));
    await this.writeChapterIndex(session, projectId, index);
    await this.ops.removeFile(this.chapterFile(projectId, chapterId), session);
    return meta;
  }

  async search(
    session: FsSession,
    projectId: string,
    query: string,
    limit: number,
  ): Promise<SearchMatch<string>[]> {
    const chapters = await this.listChapters(session, projectId);
    return searchChapters(chapters, query, { maxTotal: limit });
  }

  // ── 角色卡 ────────────────────────────────────────────────────────────

  async listCharacters(session: FsSession, projectId: string): Promise<StoredCharacter[]> {
    const dir = this.charactersDir(projectId);
    const entries = await this.ops.listDir(dir, session);
    const characters: StoredCharacter[] = [];
    for (const entry of entries) {
      if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
      const character = await this.ops.readJson<StoredCharacter>(
        `${dir}/${entry.name}`,
        session,
      );
      if (character) characters.push(character);
    }
    return characters.sort((a, b) => a.createdAt - b.createdAt);
  }

  async resolveCharacter(
    session: FsSession,
    projectId: string,
    ref: string,
  ): Promise<StoredCharacter> {
    const characters = await this.listCharacters(session, projectId);
    if (characters.length === 0) {
      throw new Error(`project "${projectId}" has no character cards yet — import one first`);
    }
    const wanted = ref.trim();
    const lower = wanted.toLowerCase();
    const exact = characters.find((c) => c.id === wanted || c.name.toLowerCase() === lower);
    if (exact) return exact;
    const partial = characters.filter((c) => c.name.toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    throw new Error(
      partial.length > 1
        ? `character "${ref}" is ambiguous: ${partial.map((c) => c.name).join(", ")}`
        : `character "${ref}" not found. Available: ${characters
            .map((c) => `${c.name} (${c.id})`)
            .join(", ")}`,
    );
  }

  /**
   * 导入 SillyTavern 角色卡（PNG/JSON，V1/V2/V3）：
   * 卡片落在 characters/ 下，头像按真实媒体类型另存为图片文件，
   * 卡内世界书按来源卡名解析 {{char}} 后并入项目 lorebook。
   */
  async importCharacter(
    session: FsSession,
    projectId: string,
    filePath: string,
  ): Promise<ImportedCharacterResult> {
    const bytes = await this.ops.readBytesOrNull(filePath, session);
    if (!bytes) throw new Error(`character card not found: ${filePath}`);
    const parsed = await parseCharacterBytes(bytes, filePath, mediaTypeOf(filePath));
    const { avatarBytes, avatarType, ...rest } = parsed.character;
    const id = uid().replace(/-/g, "").slice(0, 10);
    // 头像文件按真实媒体类型命名：非 PNG 卡的头像原样存盘，扩展名不能撒谎
    const avatar = avatarBytes ? `${id}.${extensionForMediaType(avatarType)}` : null;
    // 整体展开而不是逐字段抄写：卡解析侧新增字段时不会在这里被静默丢掉
    const character: StoredCharacter = { ...rest, id, avatar };
    if (avatarBytes && avatar) {
      await this.ops.writeBytes(
        this.characterAvatarPath(projectId, avatar),
        avatarBytes,
        session,
      );
    }
    await this.ops.writeJson(this.characterFile(projectId, id), character, session);
    const lore = await this.addLoreEntries(session, projectId, parsed.loreEntries);
    return {
      character,
      mergedLoreEntries: lore.added,
      skippedLoreEntries: lore.skipped,
    };
  }

  async updateCharacter(
    session: FsSession,
    projectId: string,
    characterId: string,
    patch: Partial<Pick<StoredCharacter, "name" | "description" | "personality" | "scenario" | "active">>,
  ): Promise<StoredCharacter> {
    const characters = await this.listCharacters(session, projectId);
    const character = characters.find((c) => c.id === characterId);
    if (!character) throw new Error(`character not found: ${characterId}`);
    if (patch.name !== undefined && !patch.name.trim()) {
      throw new Error("character name cannot be empty");
    }
    const updated: StoredCharacter = { ...character, ...patch };
    await this.ops.writeJson(this.characterFile(projectId, characterId), updated, session);
    return updated;
  }

  async deleteCharacter(
    session: FsSession,
    projectId: string,
    characterId: string,
    confirm: boolean | undefined,
  ): Promise<StoredCharacter> {
    if (!isDestructiveConfirmed(confirm)) {
      throw new Error(
        "refusing to delete a character card without confirm=true — confirm with the user first",
      );
    }
    const characters = await this.listCharacters(session, projectId);
    const character = characters.find((c) => c.id === characterId);
    if (!character) throw new Error(`character not found: ${characterId}`);
    await this.ops.removeFile(this.characterFile(projectId, characterId), session);
    if (character.avatar) {
      await this.ops.removeFile(this.characterAvatarPath(projectId, character.avatar), session);
    }
    return character;
  }

  /** 再导出为 SillyTavern 角色卡 PNG（chara + ccv3 双写） */
  async exportCharacterPng(
    session: FsSession,
    projectId: string,
    characterId: string,
    outPath?: string,
  ): Promise<{ path: string; bytes: number }> {
    const characters = await this.listCharacters(session, projectId);
    const character = characters.find((c) => c.id === characterId);
    if (!character) throw new Error(`character not found: ${characterId}`);
    // 头像按记录的文件名读取（可能是 webp/jpeg），非 PNG 时 buildCharacterPng 会用占位图
    const avatarBytes = character.avatar
      ? await this.ops.readBytesOrNull(
          this.characterAvatarPath(projectId, character.avatar),
          session,
        )
      : null;
    const png = await buildCharacterPng(character, avatarBytes ?? null);
    const target =
      outPath?.trim() || `${this.exportsDir(projectId)}/${safeName(character.name)}.png`;
    await this.ops.writeBytes(target, png, session);
    return { path: target, bytes: png.length };
  }

  // ── 导出 ──────────────────────────────────────────────────────────────

  async exportDocument(
    session: FsSession,
    projectId: string,
    format: "md" | "txt",
  ): Promise<ExportResult> {
    const project = await this.readProject(session, projectId);
    const chapters = await this.listChapters(session, projectId);
    const text = buildNovelDocument(project, chapters, format);
    const path = `${this.exportsDir(projectId)}/${safeName(project.title)}.${format}`;
    await this.ops.writeText(path, text, session);
    return {
      path,
      bytes: Buffer.byteLength(text, "utf8"),
      chapters: chapters.length,
      words: chapters.reduce((sum, chapter) => sum + chapter.words, 0),
    };
  }

  /** 全量备份：作品、章节、角色卡、预设、世界书一并落到一个 JSON */
  async exportBackup(session: FsSession, projectId: string): Promise<ExportResult> {
    const project = await this.readProject(session, projectId);
    const chapters = await this.listChapters(session, projectId);
    const characters = await this.listCharacters(session, projectId);
    const payload = {
      format: "novelnovel-backup",
      version: WORKSPACE_VERSION,
      exportedAt: new Date().toISOString(),
      project,
      lorebook: await this.readLorebook(session, projectId),
      presets: await this.readPresets(session, projectId),
      chapters,
      characters,
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const path = `${this.exportsDir(projectId)}/backup-${safeName(project.id)}-${stamp}.json`;
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    await this.ops.writeText(path, text, session);
    return {
      path,
      bytes: Buffer.byteLength(text, "utf8"),
      chapters: chapters.length,
      words: chapters.reduce((sum, chapter) => sum + chapter.words, 0),
    };
  }

  // ── 上下文组装用到的读取 ──────────────────────────────────────────────

  /** 仅参与写作的角色（active=true） */
  async activeCharacters(session: FsSession, projectId: string): Promise<StoredCharacter[]> {
    return (await this.listCharacters(session, projectId)).filter((c) => c.active);
  }

  /** 前 N 章尾部摘录（由远及近，丢弃空章节），供续写时保持情节连贯 */
  async previousExcerpts(
    session: FsSession,
    projectId: string,
    chapterId: string,
    count: number,
    chars: number,
  ): Promise<{ title: string; text: string }[]> {
    if (count <= 0 || chars <= 0) return [];
    // 先用索引定位（listChapterMetas 与 listChapters 同为 sortOrder 排序），
    // 只读需要摘录的那几章正文——否则为了一段前文要读遍全书。
    const metas = await this.listChapterMetas(session, projectId);
    const index = metas.findIndex((meta) => meta.id === chapterId);
    if (index <= 0) return [];
    const excerpts: { title: string; text: string }[] = [];
    for (const meta of metas.slice(Math.max(0, index - count), index)) {
      const content =
        (await this.ops.readTextOrNull(this.chapterFile(projectId, meta.id), session)) ?? "";
      if (!content.trim()) continue;
      excerpts.push({ title: meta.title, text: content.trim().slice(-chars) });
    }
    return excerpts;
  }
}

/**
 * update* 方法的 patch 形状。
 * 工具侧一律用这些具名类型拼 patch——写成 `Record<string, …>` 会让打错的键名通过编译，
 * 结果既没写进文件、又在返回里报告"已更新"（静默无操作）。
 */
export type ProjectPatch = Parameters<NovelStore["updateProject"]>[2];
export type ChapterMetaPatch = Parameters<NovelStore["updateChapterMeta"]>[3];
export type CharacterPatch = Parameters<NovelStore["updateCharacter"]>[3];
export type LorebookPatch = Parameters<NovelStore["updateLoreEntry"]>[3];
export type PresetPatch = Parameters<NovelStore["updatePreset"]>[3];
