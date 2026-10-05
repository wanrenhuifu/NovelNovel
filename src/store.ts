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
import { FsOps, withStaleRetry, type FsSession, type VersionBasis } from "./fsx";
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
  /** 简报一次最多带多少章前文 */
  maxPrevChapterCount: number;
  /** 单章最多摘多少字 */
  maxPrevChapterChars: number;
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
  /** 头像没能取到时说明原因（例如卡里存的是外链 URL） */
  avatarNote?: string;
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

/**
 * 章节 id 的安全字符集。
 *
 * 为什么必须有这道闸：id 会被直接当路径段拼进 `<dataDir>/projects/<pid>/chapters/<id>.md`。
 * 索引是**给人手改的普通文件**，把某条改成 `{"id":"../../other-novel/abc"}`，
 * 就能读到另一个作品的正文、甚至工作区外任意 `*.md`（后缀固定追加 `.md`）；
 * 同一个 id 还会流进 `deleteChapter` / 写正文——`assertInsideWorkspace` 只挡工作区**外**，
 * `../other-novel/x` 落在工作区内，会真的删掉别的作品。
 *
 * 生成 id 是 `uid().replace(/-/g,"").slice(0,10)`（小写十六进制），所以这个集合足够宽。
 */
const CHAPTER_ID_PATTERN = /^[A-Za-z0-9_$.-]+$/;

function isValidChapterId(id: unknown): id is string {
  return typeof id === "string" && id !== "." && id !== ".." && CHAPTER_ID_PATTERN.test(id);
}

/**
 * 索引里不合规的条目直接**丢掉**，只留合规的。
 *
 * 选择丢而不是整份报错：索引是给人手改的，一条写坏不该让整本书打不开；
 * 而放行这条路是真实的安全问题（见上）。被丢掉的条目会在读取时报出来。
 */
function sanitizeChapterIndex(index: ChapterIndex): ChapterIndex {
  if (!Array.isArray(index.items)) return { ...index, items: [] };
  const kept: ChapterMeta[] = [];
  const dropped: string[] = [];
  for (const item of index.items) {
    if (isValidChapterId(item?.id)) kept.push(item);
    else dropped.push(typeof item?.id === "string" ? item.id : String(item?.title ?? "?"));
  }
  if (dropped.length > 0) {
    throw new Error(
      `chapters/index.json contains ${String(dropped.length)} entry(ies) whose id cannot be used as a file name: ` +
        `${dropped.map((d) => JSON.stringify(d)).join(", ")}. ` +
        "Ids must match ^[A-Za-z0-9_$.-]+$ (and not be \".\" or \"..\"); fix the index before reading this project.",
    );
  }
  return { ...index, items: kept };
}

export class NovelStore {
  private readonly ops: FsOps;

  /**
   * 本进程里会话真正用过的工作目录 → **那个会话的真品**。
   *
   * 用途：Web 面板的 `/api/novel.*` 路由没有会话上下文，cwd 只能由前端告知，
   * 而「前端说什么就照什么找」等于把任意目录读取开放出去，所以只认这里记录过的目录。
   *
   * 存 Session **真品**而不是 cwd 字符串：`ctx.sandboxPolicy.resolve({ session })` 会去读
   * 会话的 projection（`session.snapshotEvents()`），喂一个 `{ header: { cwd } }` 的伪造对象
   * 会直接抛 `TypeError: session.snapshotEvents is not a function`——三条路由会全部 500/400。
   */
  private readonly workspaces = new Map<string, { readonly header: { readonly cwd?: string } }>();

  constructor(
    ctx: Context,
    private readonly config: NovelConfig,
  ) {
    this.ops = new FsOps(ctx);
  }

  /** 由工具执行上下文得到文件会话（工作目录 + 取消信号 + 沙箱策略） */
  sessionOf(exec: ToolRunContext): FsSession {
    const session = this.ops.sessionOf(exec);
    this.remember(session.cwd, exec.agent?.session);
    return session;
  }

  /** 由命令处理器等没有 exec 的场景构造文件会话 */
  sessionFor(
    session: { readonly header: { readonly cwd?: string } } | undefined,
    signal?: AbortSignal,
  ): FsSession {
    const built = this.ops.sessionFor(session, signal);
    this.remember(built.cwd, session);
    return built;
  }

  /**
   * 记下「这个工作目录被哪个会话用过」。
   *
   * 只在**真有 Session** 时记：`sessionFor(undefined)` 会兜底到 `process.cwd()`，
   * 那条不该进白名单（否则面板可能去读一个没有任何会话用过的工作区，
   * 或把「单工作区自动解析」打掉变成 403）。
   */
  private remember(cwd: string, session: { readonly header: { readonly cwd?: string } } | undefined): void {
    if (session === undefined || session.header.cwd === undefined) return;
    this.workspaces.set(cwd, session);
  }

  /**
   * 解析 Web 面板请求要用的文件会话。
   *
   * 复用**当初记下的那个真 Session**（沙箱策略要读它的 projection，伪造不出来）。
   * `cwd` 不传时的语义：本进程只见过一个工作目录就直接用它（前端不必知道路径），
   * 见过多个则不猜——返回 undefined 由调用方要求前端明确指定，避免写错作品。
   */
  workspaceOf(cwd: string | null | undefined): FsSession | undefined {
    const key =
      cwd === null || cwd === undefined || cwd === ""
        ? this.workspaces.size === 1
          ? [...this.workspaces.keys()][0]
          : undefined
        : this.workspaces.has(cwd)
          ? cwd
          : undefined;
    if (key === undefined) return undefined;
    const session = this.workspaces.get(key);
    if (session === undefined) return undefined;
    return this.ops.sessionFor(session);
  }

  /** 已知工作目录清单（供前端在 403 时自助纠正） */
  knownWorkspaces(): string[] {
    return [...this.workspaces.keys()];
  }

  /** 读工作区外的文本文件（预设/卡片导入用），文件不存在即报错 */
  async readTextFile(path: string, session: FsSession): Promise<string> {
    return this.ops.readText(path, session);
  }

  /**
   * 读 JSON 并带上 CAS 基准。所有「读-改-写」都必须走这里：
   * 先读后改的窗口内被别处改过时，写入必须失败而不是静默覆盖。
   */
  private async readJsonVersioned<T>(
    path: string,
    session: FsSession,
  ): Promise<{ value: T | null; basis: VersionBasis }> {
    const read = await this.ops.readTextVersioned(path, session);
    if (read === null) return { value: null, basis: { existed: false } };
    const basis: VersionBasis = { existed: true, version: read.version };
    try {
      // 数据文件是给人手改的（Notepad 等编辑器会写 BOM），解析前先去掉
      return { value: JSON.parse(read.text.replace(/^\uFEFF/, "")) as T, basis };
    } catch {
      throw new Error(`file is not valid JSON: ${path}`);
    }
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

  private chapterDir(id: string): string {
    return `${this.projectDir(id)}/chapters`;
  }

  private chapterIndexFile(id: string): string {
    return `${this.chapterDir(id)}/index.json`;
  }

  private chapterFile(id: string, chapterId: string): string {
    return `${this.chapterDir(id)}/${chapterId}.md`;
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
  ): Promise<{ file: WorkspaceFile; basis: VersionBasis; error?: string }> {
    try {
      const { value, basis } = await this.readJsonVersioned<WorkspaceFile>(
        `${this.root()}/workspace.json`,
        session,
      );
      return {
        file: value ?? { version: WORKSPACE_VERSION, activeProject: null },
        basis,
      };
    } catch (error: unknown) {
      return {
        file: { version: WORKSPACE_VERSION, activeProject: null },
        basis: { existed: false },
        error: (error as Error).message,
      };
    }
  }

  private async writeWorkspace(
    session: FsSession,
    file: WorkspaceFile,
    basis: VersionBasis,
  ): Promise<void> {
    await this.ops.writeJson(`${this.root()}/workspace.json`, file, session, basis);
  }

  /**
   * 切换当前作品。CAS 冲突会重试整个「读-改-写」——
   * 并发切换只是互相覆盖指针，重读一次就能收敛，不值得报错打断用户。
   */
  async setActiveProject(session: FsSession, projectId: string): Promise<void> {
    await withStaleRetry(async () => {
      const { file, basis } = await this.readWorkspace(session);
      file.activeProject = projectId;
      await this.writeWorkspace(session, file, basis);
    });
  }

  // ── 作品 ──────────────────────────────────────────────────────────────

  /**
   * 遍历作品目录并逐个读取。
   * 单个作品目录读不出来（project.json 损坏、被外部改成非 JSON 等）时跳过并记录，
   * 不让一个坏目录把整个插件的入口都堵死——否则 list / 解析当前作品全都会失败。
   * `read` 里抛错同样算作该目录不可读。
   *
   * **目录名就是作品 id**（所有读写路径都走 projectDir(id)）。project.json 里的
   * `id` 字段只是当初创建时抄的一份，用户复制/改名目录后就会与目录名分叉——
   * 那时以目录名为准，并把不一致记进 unreadable 让 `action=list` 点名，
   * 而不是让「列表显示 A、写入落在 B」这种事发生。
   */
  private async scanProjectDirs<T>(
    session: FsSession,
    read: (project: NovelProject, dir: string, active: string | null) => Promise<T>,
  ): Promise<{
    items: T[];
    unreadable: UnreadableProject[];
    active: string | null;
    workspaceError?: string;
  }> {
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
        if (typeof project.id === "string" && project.id !== entry.name) {
          throw new Error(
            `project.json id "${project.id}" does not match its directory name "${entry.name}". ` +
              "The directory name is authoritative — set project.id to it (or remove the field) to use this project",
          );
        }
        items.push(await read({ ...project, id: entry.name }, entry.name, active));
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
    if (patch.title !== undefined && !patch.title.trim()) {
      throw new Error("project title cannot be empty");
    }
    // 「读-改-写」必须带 CAS 基准 + 重试：同一轮里的两个并行 update（或两个会话）
    // 否则会互相静默覆盖——两边都报成功，只有一个字段活下来。
    return withStaleRetry(async () => {
      const { value: project, basis } = await this.readJsonVersioned<NovelProject>(
        this.projectFile(projectId),
        session,
      );
      if (project === null) throw new Error(`project "${projectId}" not found`);
      if (patch.title !== undefined) project.title = patch.title.trim();
      if (patch.synopsis !== undefined) project.synopsis = patch.synopsis;
      if (patch.worldbuilding !== undefined) project.worldbuilding = patch.worldbuilding;
      if (patch.authorNote !== undefined) project.authorNote = patch.authorNote;
      project.updatedAt = Date.now();
      await this.ops.writeJson(this.projectFile(projectId), project, session, basis);
      return project;
    });
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
    await withStaleRetry(async () => {
      const { file, basis } = await this.readWorkspace(session);
      if (file.activeProject !== projectId) return;
      file.activeProject = null;
      await this.writeWorkspace(session, file, basis);
    });
  }

  // ── 世界观词条 ────────────────────────────────────────────────────────

  /**
   * 世界书词条的**宽松**读：文件损坏时退化为空数组并记下原因，
   * 让 `novel_context` / `/novel` / 导出仍然可用——一个坏文件不该把整个简报堵死。
   * 决定写入的路径必须用 readLorebookStrict：静默当空值会把坏文件覆盖掉。
   */
  async readLorebookDiagnosed(
    session: FsSession,
    projectId: string,
  ): Promise<{ entries: LoreEntry[]; error?: string }> {
    const read = await this.ops.readJsonOrDiagnose<LoreEntry[]>(
      this.lorebookFile(projectId),
      session,
    );
    if (read.error !== undefined) return { entries: [], error: read.error };
    return { entries: read.value ?? [] };
  }

  async readLorebook(session: FsSession, projectId: string): Promise<LoreEntry[]> {
    return (await this.readLorebookDiagnosed(session, projectId)).entries;
  }

  private async readLorebookStrict(
    session: FsSession,
    projectId: string,
  ): Promise<{ entries: LoreEntry[]; basis: VersionBasis }> {
    const { value, basis } = await this.readJsonVersioned<LoreEntry[]>(
      this.lorebookFile(projectId),
      session,
    );
    if (value === null && basis.existed) {
      throw new Error(
        `cannot update the lorebook: ${this.lorebookFile(projectId)} is not valid JSON. ` +
          "Fix it (or delete the file to start from an empty lorebook), then retry.",
      );
    }
    return { entries: value ?? [], basis };
  }

  private async writeLorebook(
    session: FsSession,
    projectId: string,
    entries: LoreEntry[],
    basis: VersionBasis,
  ): Promise<void> {
    await this.ops.writeJson(this.lorebookFile(projectId), entries, session, basis);
  }

  async addLoreEntries(
    session: FsSession,
    projectId: string,
    entries: Omit<LoreEntry, "id">[],
  ): Promise<{ added: number; skipped: number; total: number }> {
    return withStaleRetry(async () => {
      const { entries: current, basis } = await this.readLorebookStrict(session, projectId);
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
      if (added > 0) await this.writeLorebook(session, projectId, current, basis);
      return { added, skipped, total: current.length };
    });
  }

  async updateLoreEntry(
    session: FsSession,
    projectId: string,
    ref: string,
    patch: { name?: string; keys?: string; content?: string; enabled?: boolean; toggle?: boolean },
  ): Promise<LoreEntry> {
    // add 侧会 trim name/keys/content；update 侧同样处理，否则 " 旧伤 " / "" 会落盘，
    // 之后精确与唯一部分匹配全都失效（只能靠 id 找）。
    if (patch.name !== undefined && !patch.name.trim()) {
      throw new Error("lorebook entry name cannot be empty");
    }
    return withStaleRetry(async () => {
      const { entries, basis } = await this.readLorebookStrict(session, projectId);
      const entry = this.findLoreEntry(entries, ref, projectId);
      if (patch.name !== undefined) entry.name = patch.name.trim();
      if (patch.keys !== undefined) entry.keys = patch.keys.trim();
      if (patch.content !== undefined) entry.content = patch.content;
      if (patch.enabled !== undefined) entry.enabled = patch.enabled;
      // toggle 在解析出唯一词条之后再翻转，避免部分匹配时读到错误的前值
      if (patch.toggle === true) entry.enabled = !entry.enabled;
      await this.writeLorebook(session, projectId, entries, basis);
      return entry;
    });
  }

  async removeLoreEntry(session: FsSession, projectId: string, ref: string): Promise<LoreEntry> {
    return withStaleRetry(async () => {
      const { entries, basis } = await this.readLorebookStrict(session, projectId);
      const entry = this.findLoreEntry(entries, ref, projectId);
      await this.writeLorebook(
        session,
        projectId,
        entries.filter((e) => e.id !== entry.id),
        basis,
      );
      return entry;
    });
  }

  /**
   * 解析词条引用：id / 名称精确 / 名称部分匹配。
   * 候选清单截断为前 20 条——几千个词条时把它整份塞进模型可见的错误文本，
   * 一次拼错就吃掉大量上下文。
   */
  private findLoreEntry(entries: LoreEntry[], ref: string, projectId: string): LoreEntry {
    const wanted = ref.trim();
    const lower = wanted.toLowerCase();
    const exact = entries.find((e) => e.id === wanted || e.name.toLowerCase() === lower);
    if (exact) return exact;
    const partial = entries.filter((e) => e.name.toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    if (entries.length === 0) throw new Error(`project "${projectId}" has no lorebook entries yet`);
    const names = entries.map((e) => e.name);
    const shown = names.slice(0, 20).join(", ");
    const more = names.length > 20 ? ` … and ${names.length - 20} more` : "";
    throw new Error(
      partial.length > 1
        ? `lorebook entry "${ref}" is ambiguous: ${partial.map((e) => e.name).join(", ")}`
        : `lorebook entry "${ref}" not found. Available: ${shown}${more}`,
    );
  }

  // ── 写作预设 ──────────────────────────────────────────────────────────

  /**
   * 写作预设的宽松读：文件坏了退化为空并记原因（简报要能继续组装）。
   * 决定写入的路径用 readPresetsStrict。
   */
  async readPresetsDiagnosed(
    session: FsSession,
    projectId: string,
  ): Promise<{ file: PresetFile; error?: string }> {
    const read = await this.ops.readJsonOrDiagnose<PresetFile>(
      this.presetsFile(projectId),
      session,
    );
    if (read.error !== undefined) {
      return { file: { activePresetId: null, presets: [] }, error: read.error };
    }
    return { file: read.value ?? { activePresetId: null, presets: [] } };
  }

  async readPresets(session: FsSession, projectId: string): Promise<PresetFile> {
    return (await this.readPresetsDiagnosed(session, projectId)).file;
  }

  private async readPresetsStrict(
    session: FsSession,
    projectId: string,
  ): Promise<{ file: PresetFile; basis: VersionBasis }> {
    const { value, basis } = await this.readJsonVersioned<PresetFile>(
      this.presetsFile(projectId),
      session,
    );
    if (value === null && basis.existed) {
      throw new Error(
        `cannot change presets: ${this.presetsFile(projectId)} is not valid JSON. ` +
          "Fix it (or delete the file to start from no presets), then retry.",
      );
    }
    return { file: value ?? { activePresetId: null, presets: [] }, basis };
  }

  private async writePresets(
    session: FsSession,
    projectId: string,
    file: PresetFile,
    basis: VersionBasis,
  ): Promise<void> {
    await this.ops.writeJson(this.presetsFile(projectId), file, session, basis);
  }

  /**
   * 按新的 kind 重算激活指针，返回「现在还生效吗」。
   *
   * 同名重导入如果换了 kind（context ⇄ system ⇄ instruct），原 id 虽然还在，
   * `activePreset()` 却会对 instruct 返回 null——简报静默退回内置默认提示词，
   * 而返回信息说「stays active」。所以替换后必须重算并如实报告。
   */
  private reconcileActivePreset(file: PresetFile): void {
    const active = file.presets.find((p) => p.id === file.activePresetId);
    if (active && active.kind === "instruct") file.activePresetId = null;
  }

  /** 从 JSON 文本导入预设（识别裸预设与合订信封，见 presetImport.ts） */
  async importPreset(
    session: FsSession,
    projectId: string,
    text: string,
  ): Promise<{ preset: Preset; note?: string; activated: boolean; replacedActive: boolean }> {
    const { preset, note } = parsePresetFile(text);
    return withStaleRetry(async () => {
      const { file, basis } = await this.readPresetsStrict(session, projectId);
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
      // 替换可能把原来的激活项变成 instruct（或反之）：先记下原状态，重算后如实报告
      const wasActive = replacedId !== null && file.activePresetId === replacedId;
      this.reconcileActivePreset(file);
      const replacedActive = wasActive && file.activePresetId === replacedId;
      await this.writePresets(session, projectId, file, basis);
      return { preset: stored, ...(note ? { note } : {}), activated, replacedActive };
    });
  }

  async addPreset(
    session: FsSession,
    projectId: string,
    input: { name: string; systemPrompt?: string; storyString?: string },
  ): Promise<{ preset: Preset; activated: boolean }> {
    const name = input.name.trim();
    if (!name) throw new Error("preset name is required");
    return withStaleRetry(async () => {
      const { file, basis } = await this.readPresetsStrict(session, projectId);
      // 同名并存会让 resolvePreset 的精确匹配永远命中第一个、第二个只能靠 id 操作，
      // 所以这里直接拒绝，指路去用 action=update。
      if (file.presets.some((p) => p.name === name)) {
        throw new Error(
          `a preset named "${name}" already exists — edit it with action=update, ` +
            "or pick a different name",
        );
      }
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
      await this.writePresets(session, projectId, file, basis);
      return { preset, activated };
    });
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
    const shown = all.slice(0, 20).map((preset) => `${preset.id} (${preset.name})`);
    const more = all.length > 20 ? ` … and ${all.length - 20} more` : "";
    throw new Error(
      partial.length > 1
        ? `preset "${ref}" is ambiguous: ${partial.map((preset) => preset.name).join(", ")}`
        : `preset "${ref}" not found. Available: ${shown.join(", ")}${more}`,
    );
  }

  async updatePreset(
    session: FsSession,
    projectId: string,
    presetId: string,
    patch: { name?: string; systemPrompt?: string; storyString?: string },
  ): Promise<Preset> {
    if (patch.name !== undefined && !patch.name.trim()) {
      throw new Error("preset name cannot be empty");
    }
    return withStaleRetry(async () => {
      const { file, basis } = await this.readPresetsStrict(session, projectId);
      const preset = file.presets.find((p) => p.id === presetId);
      if (!preset) throw new Error(`preset not found: ${presetId}`);
      if (patch.name !== undefined) preset.name = patch.name.trim();
      if (patch.systemPrompt !== undefined) preset.systemPrompt = patch.systemPrompt;
      if (patch.storyString !== undefined) {
        preset.storyString = patch.storyString;
        // kind 跟着内容走：story_string 有了就是 context，否则退回 system
        preset.kind = patch.storyString.trim() ? "context" : "system";
      }
      this.reconcileActivePreset(file);
      await this.writePresets(session, projectId, file, basis);
      return preset;
    });
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
    return withStaleRetry(async () => {
      const { file, basis } = await this.readPresetsStrict(session, projectId);
      if (presetId !== null) {
        const preset = file.presets.find((p) => p.id === presetId);
        if (!preset) throw new Error(`preset not found: ${presetId}`);
        if (preset.kind === "instruct") {
          throw new Error(
            `preset "${preset.name}" is an instruct preset: it only controls dialogue formatting, ` +
              `which the harness owns, so it is archived but never applied`,
          );
        }
        file.activePresetId = preset.id;
      } else {
        file.activePresetId = null;
      }
      await this.writePresets(session, projectId, file, basis);
      return file;
    });
  }

  async removePreset(session: FsSession, projectId: string, presetId: string): Promise<Preset> {
    return withStaleRetry(async () => {
      const { file, basis } = await this.readPresetsStrict(session, projectId);
      const preset = file.presets.find((p) => p.id === presetId);
      if (!preset) throw new Error(`preset not found: ${presetId}`);
      file.presets = file.presets.filter((p) => p.id !== presetId);
      if (file.activePresetId === presetId) file.activePresetId = null;
      await this.writePresets(session, projectId, file, basis);
      return preset;
    });
  }

  /** 当前参与提示词组装的预设（instruct 不参与，未激活时为 null） */
  activePreset(file: PresetFile): Preset | null {
    if (!file.activePresetId) return null;
    const preset = file.presets.find((p) => p.id === file.activePresetId) ?? null;
    return preset && preset.kind !== "instruct" ? preset : null;
  }

  // ── 章节 ──────────────────────────────────────────────────────────────

  /** 读章节索引 + CAS 基准（改动索引的路径必须用它） */
  private async readChapterIndexVersioned(
    session: FsSession,
    projectId: string,
  ): Promise<{ index: ChapterIndex; basis: VersionBasis }> {
    const { value, basis } = await this.readJsonVersioned<ChapterIndex>(
      this.chapterIndexFile(projectId),
      session,
    );
    return { index: sanitizeChapterIndex(value ?? { items: [] }), basis };
  }

  private async readChapterIndex(session: FsSession, projectId: string): Promise<ChapterIndex> {
    return (await this.readChapterIndexVersioned(session, projectId)).index;
  }

  /**
   * 写索引前的安全闸：**只要目录里存在索引未引用的 `.md`，就拒绝写入**。
   *
   * 为什么不能只看"索引是否存在"：索引是给人手改的普通文件，把它改成 `{}`、`[]`、`null`
   * 或 `{"items":null}` 时 JSON **能解析**、`basis.existed === true`，于是旧的存在性判定直接放行，
   * 紧接着写入「只含新章」的索引——全书大纲（标题/标签/顺序）一次性消失，已有正文全成孤儿，
   * 而工具还报成功。所以判据必须是内容层面的：**索引没引用到的正文文件**。
   *
   * 同一个检查顺带让另外两种残骸可见：并发建章重试留下的孤儿 `.md`、
   * 以及 `moveChapter` 旧实现把 payload 与基准分开读时丢掉的那一章。
   *
   * @param index 即将写入的索引（新的那份，不是读到的旧那份）
   * @param known 目录里实际存在的 `.md` 文件名（不含扩展名）
   */
  private assertNoOrphanChapters(
    index: ChapterIndex,
    known: string[],
    projectId: string,
  ): void {
    const referenced = new Set(index.items.map((item) => item.id));
    const orphans = known.filter((name) => !referenced.has(name));
    if (orphans.length === 0) return;
    throw new Error(
      `${orphans.length} chapter file(s) under ${this.chapterDir(projectId)} are not listed in ` +
        `chapters/index.json (e.g. ${orphans.slice(0, 3).join(", ")}). Writing this index would drop them ` +
        "from the outline even though their text is still on disk. Repair chapters/index.json (or move " +
        "those .md files away), then retry.",
    );
  }

  /** 目录里已存在的正文文件名（不含 `.md`），用于孤儿检查 */
  private async chapterBodyIds(session: FsSession, projectId: string): Promise<string[]> {
    const entries = await this.ops.listDir(this.chapterDir(projectId), session);
    return entries
      .filter((entry) => entry.type === "file" && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -3));
  }

  private async writeChapterIndex(
    session: FsSession,
    projectId: string,
    index: ChapterIndex,
    basis: VersionBasis,
  ): Promise<void> {
    // 所有写索引的路径都过这道闸：新索引里没有的正文文件一旦存在，就说明这次写入会
    // 把它们从大纲里丢掉（索引被手改成 {}、并发重试留下的孤儿、旧实现丢章都长这样）。
    const known = await this.chapterBodyIds(session, projectId);
    this.assertNoOrphanChapters(index, known, projectId);
    await this.ops.writeJson(this.chapterIndexFile(projectId), index, session, basis);
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

  /**
   * 解析章节引用：id / 标题（精确或唯一部分匹配）/ 第N章。
   *
   * **顺序很关键**：先 id、再**标题**、最后才按序号。反过来的话，一个形如 `3` 的引用
   * 会被当成"第 3 章"——即使存在一章标题就叫「3」，或者模型把引用写成 `第3章 觉醒`
   * 这种带尾随文字的形态时，用户拿到的是另一章的正文，而且**不报错**。
   * 序号只认「没有任何标题匹配」这一种情况，并在歧义时报出来。
   */
  async resolveChapterId(
    session: FsSession,
    projectId: string,
    ref: string,
  ): Promise<ChapterMeta> {
    const items = await this.listChapterMetas(session, projectId);
    if (items.length === 0) {
      throw new Error(`project "${projectId}" has no chapters yet — create one first`);
    }
    const wanted = (ref ?? "").trim();
    if (wanted === "") {
      throw new Error(
        `chapter reference is empty. Pass a chapter id, its title, or "第N章". Available: ${items
          .map((m, i) => `${i + 1}. ${m.title} (${m.id})`)
          .join(", ")}`,
      );
    }

    // 1) id 精确
    const byId = items.find((m) => m.id === wanted);
    if (byId) return byId;

    // 2) 标题精确 → 唯一部分匹配（在序号之前：标题是更强的意图表达）
    const lower = wanted.toLowerCase();
    const byTitle = items.find((m) => m.title.toLowerCase() === lower);
    if (byTitle) return byTitle;
    const partial = items.filter((m) => m.title.toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];

    // 3) 序号：仅当没有任何标题命中时才允许（避免"标题叫 3 的章"被序号抢走）
    const ordinal = /^\s*(?:第)?(\d+)(?:章|节|话|回)?\s*$/.exec(wanted);
    if (ordinal !== null && partial.length === 0) {
      const n = Number(ordinal[1]);
      if (n >= 1 && n <= items.length) return items[n - 1];
      throw new Error(
        `chapter ordinal ${String(n)} is out of range (this project has ${String(items.length)} chapters). Available: ${items
          .map((m, i) => `${i + 1}. ${m.title} (${m.id})`)
          .join(", ")}`,
      );
    }

    throw new Error(
      partial.length > 1
        ? `chapter "${ref}" is ambiguous: ${partial.map((m) => m.title).join(", ")}`
        : `chapter "${ref}" not found. Available: ${items
            .map((m, i) => `${i + 1}. ${m.title} (${m.id})`)
            .join(", ")}`,
    );
  }

  /**
   * 读章节正文 + CAS 基准。
   * 索引里有条目但正文文件不见了时**报错**，而不是返回空串：否则后续 append 会把
   * 「正文被外部删掉」伪装成「新建了一个空章」。
   */
  private async readChapterBodyVersioned(
    session: FsSession,
    projectId: string,
    chapterId: string,
  ): Promise<{ text: string; basis: VersionBasis }> {
    const read = await this.ops.readTextVersioned(this.chapterFile(projectId, chapterId), session);
    if (read === null) {
      throw new Error(
        `chapter body is missing: ${this.chapterFile(projectId, chapterId)} — the index still lists ` +
          "this chapter. Restore the file, or delete the chapter and create it again.",
      );
    }
    return { text: read.text, basis: { existed: true, version: read.version } };
  }

  async readChapter(session: FsSession, projectId: string, ref: string): Promise<Chapter> {
    const meta = await this.resolveChapterId(session, projectId, ref);
    const content = await this.ops.readTextOrNull(this.chapterFile(projectId, meta.id), session);
    if (content === null) {
      // 索引里说有这么一章，正文文件却不在：这跟"空章"是两回事。
      // 静默返回空串会把「正文被删了」伪装成「这章还没写」，用户会以为内容丢了却查不出原因。
      throw new Error(
        `chapter "${meta.title}" [${meta.id}] is listed in chapters/index.json but its body file is missing ` +
          `(expected ${this.chapterFile(projectId, meta.id)}). The file was deleted or moved outside the plugin.`,
      );
    }
    return { ...meta, content, words: countWords(content) };
  }

  /**
   * 新建章节。
   * 顺序是「先写正文、再写索引」：索引写失败只会留一个孤儿 .md（可见、可修），
   * 反过来的话索引里会多出一个没有正文的章节（`readChapter` 立刻报错）。
   */
  async createChapter(
    session: FsSession,
    projectId: string,
    input: { title: string; content?: string; tags?: string[]; position?: number },
  ): Promise<Chapter> {
    const title = input.title.trim();
    if (!title) throw new Error("chapter title is required");
    return withStaleRetry(async () => {
      const { index, basis } = await this.readChapterIndexVersioned(session, projectId);
      // 索引被手改坏（`{}`/`[]`/`null`）时的保护不在这里，而在 writeChapterIndex 的孤儿检查里：
      // 那样无论从哪条路径写索引都拦得住，不依赖调用方记得先调一次。
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
      await this.writeChapterIndex(session, projectId, index, basis);
      return { ...index.items[position - 1], content, words: countWords(content) };
    });
  }

  /**
   * 改动章节元数据。索引是共享文件（并发建章/移动/改名都会撞它），
   * 所以 CAS 冲突重试整个「读-改-写」：重读一次拿到最新顺序再套用同一处 patch。
   */
  private async patchChapter(
    session: FsSession,
    projectId: string,
    chapterId: string,
    patch: (meta: ChapterMeta) => void,
  ): Promise<ChapterMeta> {
    return withStaleRetry(async () => {
      const { index, basis } = await this.readChapterIndexVersioned(session, projectId);
      const meta = index.items.find((item) => item.id === chapterId);
      if (!meta) throw new Error(`chapter not found: ${chapterId}`);
      patch(meta);
      meta.updatedAt = Date.now();
      await this.writeChapterIndex(session, projectId, index, basis);
      return meta;
    });
  }

  /**
   * 覆写章节正文（`action=write` 的落盘口）。
   *
   * **没有外部基准时，自己先读一次拿到基准**：`action=write` 是"整体替换"，
   * 而它的典型用法是「先 read 让模型看到全文 → 模型重写 → write 回来」，那中间有一个
   * 跨工具调用的窗口——用户或另一个会话在这段时间里直接编辑正文（README 就是这么建议的）
   * 就会被静默覆盖，而且正文没有历史可恢复。
   * 收不进单次调用（模型看不见版本号），但至少把窗口从「两次调用之间」缩到「一次调用内」：
   * 读到的版本若在写入前被改过，CAS 会失败并让调用方重试，而不是无声覆盖。
   */
  async writeChapterBody(
    session: FsSession,
    projectId: string,
    chapterId: string,
    content: string,
    expected?: VersionBasis,
  ): Promise<Chapter> {
    const meta = await this.patchChapter(session, projectId, chapterId, () => {});
    const basis = expected ?? (await this.readChapterBodyVersioned(session, projectId, chapterId)).basis;
    await this.ops.writeText(
      this.chapterFile(projectId, chapterId),
      content,
      session,
      basis,
    );
    return { ...meta, content, words: countWords(content) };
  }

  /**
   * 追加正文（续写的落地写入口）。
   *
   * 负载**不做 trim**：前导空行与 markdown 硬换行（行尾两空格）都是正文的一部分，
   * 「追加」不应该顺手重写它们。只在需要时补一个段落分隔。
   */
  async appendChapterBody(
    session: FsSession,
    projectId: string,
    chapterId: string,
    text: string,
  ): Promise<Chapter> {
    return withStaleRetry(async () => {
      const { text: current, basis } = await this.readChapterBodyVersioned(
        session,
        projectId,
        chapterId,
      );
      const joined =
        current.length === 0
          ? text
          : current.replace(/\n*$/, "") + "\n\n" + text.replace(/\n*$/, "") + "\n";
      return this.writeChapterBody(session, projectId, chapterId, joined, basis);
    });
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
    return withStaleRetry(async () => {
      // payload 与 CAS 基准必须来自**同一次读**：分两次读的话，基准是在 payload 之后取的，
      // 于是并发建章/改名落在两次读之间时 CAS 必然通过 → 那边的新章节被这份旧列表静默覆盖。
      const { index, basis } = await this.readChapterIndexVersioned(session, projectId);
      const items = [...index.items].sort((a, b) => a.sortOrder - b.sortOrder);
      const reordered = computeReorder(items, chapterId, targetId, position);
      if (!reordered) {
        const available = items.map((m) => `${m.title} (${m.id})`).join(", ");
        throw new Error(
          `cannot move chapter: "${chapterId}" → ${position} "${targetId}". Available: ${available}`,
        );
      }
      await this.writeChapterIndex(session, projectId, { items: reordered }, basis);
      return reordered;
    });
  }

  /**
   * 删除章节。**先删正文、再改索引**：反过来一旦删文件失败，章节已经从书里消失、
   * 工具却报错，模型会再删一次，而残留的 .md 永远不可见也没人清理。
   */
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
    return withStaleRetry(async () => {
      const { index, basis } = await this.readChapterIndexVersioned(session, projectId);
      const meta = index.items.find((item) => item.id === chapterId);
      if (!meta) throw new Error(`chapter not found: ${chapterId}`);
      index.items = index.items
        .filter((item) => item.id !== chapterId)
        .map((item, i) => ({ ...item, sortOrder: i }));
      await this.ops.removeFile(this.chapterFile(projectId, chapterId), session);
      await this.writeChapterIndex(session, projectId, index, basis);
      return meta;
    });
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

  /**
   * 角色卡列表。单张卡手改坏时跳过并点名（与作品目录同一口径），
   * 而不是让 `novel_context` / `novel_character list` 整体失效。
   */
  async listCharactersDiagnosed(
    session: FsSession,
    projectId: string,
  ): Promise<{
    characters: StoredCharacter[];
    broken: { file: string; error: string }[];
    /** 每个角色卡文件的读取版本，供「读-改-写」当 CAS 基准（键为文件名） */
    bases: Map<string, VersionBasis>;
  }> {
    const dir = this.charactersDir(projectId);
    const entries = await this.ops.listDir(dir, session);
    const characters: StoredCharacter[] = [];
    const broken: { file: string; error: string }[] = [];
    const bases = new Map<string, VersionBasis>();
    for (const entry of entries) {
      if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
      const read = await this.ops.readJsonOrDiagnose<StoredCharacter>(
        `${dir}/${entry.name}`,
        session,
      );
      if (read.error !== undefined) {
        broken.push({ file: `${dir}/${entry.name}`, error: read.error });
        continue;
      }
      bases.set(entry.name, read.basis);
      if (read.value) characters.push(read.value);
    }
    return {
      characters: characters.sort((a, b) => a.createdAt - b.createdAt),
      broken,
      bases,
    };
  }

  async listCharacters(session: FsSession, projectId: string): Promise<StoredCharacter[]> {
    return (await this.listCharactersDiagnosed(session, projectId)).characters;
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
    const shown = characters.slice(0, 20).map((c) => `${c.name} (${c.id})`);
    const more = characters.length > 20 ? ` … and ${characters.length - 20} more` : "";
    throw new Error(
      partial.length > 1
        ? `character "${ref}" is ambiguous: ${partial.map((c) => c.name).join(", ")}`
        : `character "${ref}" not found. Available: ${shown.join(", ")}${more}`,
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
    // 落盘之前先确认世界书**能不能读**：lorebook.json 坏了的时候在这里就失败，
    // 而不是写完卡片、头像之后再抛错，留下「报失败但卡片已 active 并参与简报」的半成品。
    await this.readLorebookStrict(session, projectId);
    const { avatarBytes, avatarType, avatarNote, ...rest } = parsed.character;
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
    try {
      const lore = await this.addLoreEntries(session, projectId, parsed.loreEntries);
      return {
        character,
        mergedLoreEntries: lore.added,
        skippedLoreEntries: lore.skipped,
        ...(avatarNote !== undefined ? { avatarNote } : {}),
      };
    } catch (error: unknown) {
      // 词条合并失败就**回滚卡片与头像**：否则模型重试会再建一张新 id 的同名卡，
      // 两张都 active、都注入简报。回滚本身失败也不能掩盖原始错误。
      await this.ops.removeFile(this.characterFile(projectId, id), session).catch(() => undefined);
      if (avatar) {
        await this.ops
          .removeFile(this.characterAvatarPath(projectId, avatar), session)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async updateCharacter(
    session: FsSession,
    projectId: string,
    characterId: string,
    patch: Partial<Pick<StoredCharacter, "name" | "description" | "personality" | "scenario" | "active">>,
  ): Promise<StoredCharacter> {
    if (patch.name !== undefined && !patch.name.trim()) {
      throw new Error("character name cannot be empty");
    }
    // 「读-改-写」必须带 CAS 基准：两个会话（比如面板与模型）同时改同一张卡时，
    // 不带基准的写入会把对方的改动静默覆盖。这里整段套重试，冲突就重读再改一次。
    return withStaleRetry(async () => {
      const { characters, bases } = await this.listCharactersDiagnosed(session, projectId);
      const character = characters.find((c) => c.id === characterId);
      if (!character) throw new Error(`character not found: ${characterId}`);
      const updated: StoredCharacter = { ...character, ...patch };
      const file = this.characterFile(projectId, characterId);
      const basis = bases.get(`${characterId}.json`);
      await this.ops.writeJson(file, updated, session, basis);
      return updated;
    });
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
    // 不覆盖：导出文件名是固定的，再导一次就抹掉上一份——用户可能已经在那份上改过。
    // 与角色卡导出 PNG（writeBytes 同样默认拒绝覆盖）保持同一套规矩。
    await this.ops.writeText(path, text, session, undefined, false);
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
