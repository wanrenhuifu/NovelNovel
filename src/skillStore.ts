/**
 * 项目级技能：harness 自己技能根（项目根 `.dsh/skills/`）下的 SKILL.md 文件。
 *
 * 这里**不新增技能机制**：写进去的文件由 harness 的本地 provider 扫描（rank 100），与用户手写的
 * 技能走同一条加载路径，并且会覆盖插件同名的内置技能（rank 250）。插件只负责导入/导出/删除。
 *
 * 这也是本插件唯一往 <dataDir> 之外写文件的地方——技能属于整个工作区，不属于某部作品。
 * 因此可写范围在这里显式收紧到会话工作目录内（见 skillsRoot）。
 */
import { join } from "node:path";
import type { Context, ToolRunContext } from "./contract";
import { parseSkillFile, type SkillFrontmatter } from "./domain/skillFrontmatter";
import {
  ancestorDirs,
  buildSkillPack,
  parseSkillPack,
  renderPackedSkill,
  type SkillPack,
} from "./domain/skillPack";
import { FsOps, type FsSession } from "./fsx";
import { bundledSkillNames } from "./skills";

/** 导入标记。放在技能目录里当普通资源文件——harness 只把 SKILL.md 当目录变更，额外文件不影响监听 */
const MARKER_FILE = ".novelnovel-skill.json";

export interface SkillMarker {
  /** 来源技能包的展示名 */
  pack: string;
  author?: string;
  version?: string;
  importedAt: number;
}

export interface ProjectSkill {
  /** frontmatter 里的技能名（harness 的技能标识就是它） */
  name: string;
  description: string;
  /** 展示路径 */
  path: string;
  /** 目录形 `<name>/SKILL.md` 的技能目录；扁平形 `<name>.md` 为 null */
  dir: string | null;
  file: string;
  /** 由 novel_skill 导入的标记；缺失 = 用户手写的技能 */
  imported?: SkillMarker;
  /** 与插件内置技能同名：实际生效的是这一份（rank 100 覆盖 250） */
  shadowsBundled: boolean;
}

export interface SkillImportResult {
  pack: string;
  written: { name: string; path: string; overwritten: boolean }[];
}

export class SkillStore {
  private readonly ops: FsOps;

  constructor(
    private readonly ctx: Context,
    private readonly dataDir: string,
  ) {
    this.ops = new FsOps(ctx);
  }

  /** 由工具执行上下文得到文件会话（工作目录 + 取消信号 + 沙箱策略） */
  sessionOf(exec: ToolRunContext): FsSession {
    return this.ops.sessionOf(exec);
  }

  /**
   * harness 的项目根：从 cwd 往上找第一个含 `.git` 的目录，没有则用 cwd。
   * 与 skill-filesystem 本地 provider 同一口径（它也是走文件系统服务探测 `.git`）。
   * 探测失败（例如沙箱不允许 stat 工作区外的祖先）按「不存在」处理继续往上，保证结果一致。
   */
  private async findProjectRoot(session: FsSession): Promise<string> {
    for (const dir of ancestorDirs(session.cwd)) {
      try {
        const target = await this.ops.resolve(join(dir, ".git"), session);
        if ((await this.ctx.fs.stat(target, session.signal)) !== undefined) return dir;
      } catch {
        continue;
      }
    }
    return session.cwd;
  }

  /**
   * 项目技能根。会话开在 git 仓库的子目录里时，项目根落在 cwd 之外——harness 扫的是那里，
   * 而本插件的写入受沙箱与「数据不出工作区」约束，两边够不着同一个地方。
   * 这种情况**拒绝而不是猜**（与「当前作品有歧义时要求显式传 project=」同一条原则）：
   * 若默默写到 <cwd>/.dsh/skills，工具会报成功而 harness 根本不会加载它。
   */
  private async skillsRoot(session: FsSession): Promise<string> {
    const projectRoot = await this.findProjectRoot(session);
    const root = join(projectRoot, ".dsh", "skills");
    const cwd = await this.ops.resolve(session.cwd, session);
    const target = await this.ops.resolve(root, session);
    if (!this.ctx.fs.contains(cwd, target)) {
      throw new Error(
        `project skills live at "${target.displayPath}", which is outside this session's workspace ` +
          `(${cwd.displayPath}). The harness scans .dsh/skills under the nearest directory containing .git, ` +
          "and this plugin will not write outside the workspace — start the session from the project root, " +
          "or put the SKILL.md files there by hand.",
      );
    }
    return root;
  }

  private async exists(path: string, session: FsSession): Promise<boolean> {
    const target = await this.ops.resolve(path, session);
    return (await this.ctx.fs.stat(target, session.signal)) !== undefined;
  }

  /** 解析一个技能文件；不是技能（缺 frontmatter、名字非法等）返回 null 而不是抛错 */
  /**
   * 解析 SKILL.md，失败时**带上原因**返回。
   *
   * 原来只返回 null、调用方直接跳过——于是"有个技能文件但解析不了"表现为**它从列表里消失**，
   * 用户看到的是"我明明放了一个技能，工具说没有"。同类的静默今天已经修过三处
   * （缺正文的章节、前文摘录、索引列着正文不在），这里把原因留下来让上层点名。
   */
  private parseOrNull(
    text: string,
    file: string,
  ): { frontmatter: SkillFrontmatter; content: string } | { error: string } {
    try {
      return parseSkillFile(text, file);
    } catch (error: unknown) {
      return { error: String((error as Error)?.message ?? error) };
    }
  }

  private async describe(
    file: string,
    dir: string | null,
    bundled: string[],
    session: FsSession,
  ): Promise<{ skill: ProjectSkill } | { broken: { path: string; error: string } } | null> {
    const text = await this.ops.readTextOrNull(file, session);
    if (text === null) return null;
    const parsed = this.parseOrNull(text, file);
    if ("error" in parsed) {
      return { broken: { path: (await this.ops.resolve(file, session)).displayPath, error: parsed.error } };
    }
    const marker = dir ? await this.ops.readJson<SkillMarker>(join(dir, MARKER_FILE), session) : null;
    return {
      skill: {
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        path: (await this.ops.resolve(file, session)).displayPath,
        dir,
        file,
        ...(marker ? { imported: marker } : {}),
        shadowsBundled: bundled.includes(parsed.frontmatter.name),
      },
    };
  }

  /**
   * 列出技能根下的技能。harness 两种形状都认：目录形 `<name>/SKILL.md` 与扁平形 `<name>.md`。
   * 解析不了的文件进 `broken` 并带上原因——不能静默跳过（那会让"技能明明在、工具说没有"）。
   */
  async list(session: FsSession): Promise<ProjectSkill[]> {
    return (await this.listDiagnosed(session)).skills;
  }

  async listDiagnosed(
    session: FsSession,
  ): Promise<{ skills: ProjectSkill[]; broken: { path: string; error: string }[] }> {
    const root = await this.skillsRoot(session);
    const bundled = await bundledSkillNames((message) => this.ctx.logger.warn(message));
    const skills: ProjectSkill[] = [];
    const broken: { path: string; error: string }[] = [];
    for (const entry of await this.ops.listDir(root, session)) {
      const candidate =
        entry.type === "directory"
          ? { file: join(root, entry.name, "SKILL.md"), dir: join(root, entry.name) }
          : entry.type === "file" && entry.name.endsWith(".md")
            ? { file: join(root, entry.name), dir: null }
            : null;
      if (candidate === null) continue;
      const found = await this.describe(candidate.file, candidate.dir, bundled, session);
      if (found === null) continue;
      if ("broken" in found) broken.push(found.broken);
      else skills.push(found.skill);
    }
    return { skills: skills.sort((a, b) => a.name.localeCompare(b.name)), broken };
  }

  /** 解析技能引用：名字精确 → 名字唯一部分匹配（与章节、角色卡、预设的解析口径一致） */
  private async resolveSkill(session: FsSession, ref: string): Promise<ProjectSkill> {
    const skills = await this.list(session);
    const wanted = ref.trim().toLowerCase();
    const exact = skills.find((skill) => skill.name.toLowerCase() === wanted);
    if (exact) return exact;
    const partial = skills.filter((skill) => skill.name.toLowerCase().includes(wanted));
    if (partial.length === 1) return partial[0];
    if (skills.length === 0) {
      throw new Error("this project has no skills yet — import one with novel_skill action=import");
    }
    throw new Error(
      partial.length > 1
        ? `skill "${ref}" is ambiguous: ${partial.map((skill) => skill.name).join(", ")}`
        : `skill "${ref}" not found. Available: ${skills.map((skill) => skill.name).join(", ")}`,
    );
  }

  /** 把一套技能文件转成技能包（与 parseSkillPack 同一个格式，导出的包能直接再导入） */
  private async asPack(skills: ProjectSkill[], session: FsSession): Promise<SkillPack> {
    const packed = await Promise.all(
      skills.map(async (skill) => {
        const parsed = this.parseOrNull((await this.ops.readText(skill.file, session)), skill.file);
        if ("error" in parsed) {
          throw new Error(`skill "${skill.name}" is no longer readable (${parsed.error}): ${skill.path}`);
        }
        return {
          name: parsed.frontmatter.name,
          description: parsed.frontmatter.description,
          ...(parsed.frontmatter.whenToUse ? { whenToUse: parsed.frontmatter.whenToUse } : {}),
          ...(parsed.frontmatter.modelInvocable ? {} : { modelInvocable: false }),
          ...(parsed.frontmatter.userInvocable ? {} : { userInvocable: false }),
          content: parsed.content,
        };
      }),
    );
    const meta = skills[0]?.imported;
    return buildSkillPack(
      {
        name: meta?.pack ?? skills[0]?.name ?? "skill pack",
        ...(meta?.author ? { author: meta.author } : {}),
        ...(meta?.version ? { version: meta.version } : {}),
      },
      packed,
    );
  }

  /**
   * 导入技能包。先全部校验再落盘——不能写了一半才发现第 3 个技能名非法。
   * 目标目录已存在且不是本插件导入的（没有标记）时拒绝，除非 overwrite=true。
   */
  async importPack(
    session: FsSession,
    path: string,
    overwrite: boolean | undefined,
  ): Promise<SkillImportResult> {
    const root = await this.skillsRoot(session);
    const pack = parseSkillPack(await this.ops.readText(path, session));
    const plan = pack.skills.map((skill) => ({
      skill,
      text: renderPackedSkill(skill),
      dir: join(root, skill.name),
    }));

    const occupied: { name: string; display: string }[] = [];
    for (const item of plan) {
      const dirTarget = await this.ops.resolve(item.dir, session);
      if ((await this.ctx.fs.stat(dirTarget, session.signal)) === undefined) continue;
      const marker = await this.ops.readJson<SkillMarker>(join(item.dir, MARKER_FILE), session);
      if (!marker) occupied.push({ name: item.skill.name, display: dirTarget.displayPath });
    }
    if (occupied.length > 0 && overwrite !== true) {
      throw new Error(
        `${occupied.map((item) => `"${item.name}"`).join(", ")} already exist and were not imported by ` +
          `novel_skill (${occupied.map((item) => item.display).join(", ")}) — importing would overwrite ` +
          "hand-written skills. Re-run with overwrite=true only after checking with the user.",
      );
    }

    const marker: SkillMarker = {
      pack: pack.name,
      ...(pack.author ? { author: pack.author } : {}),
      ...(pack.version ? { version: pack.version } : {}),
      importedAt: Date.now(),
    };
    const written: SkillImportResult["written"] = [];
    for (const item of plan) {
      const file = join(item.dir, "SKILL.md");
      const overwritten = await this.exists(file, session);
      // 先写标记再写技能：中途失败只会留下一个没有 SKILL.md 的目录（list 会忽略它），
      // 反过来则会留下一个没有标记的技能，之后 novel_skill 拒绝删除它。
      await this.ops.writeJson(join(item.dir, MARKER_FILE), marker, session);
      await this.ops.writeText(file, item.text, session);
      written.push({
        name: item.skill.name,
        path: (await this.ops.resolve(file, session)).displayPath,
        overwritten,
      });
    }
    return { pack: pack.name, written };
  }

  /** 删除一个由 novel_skill 导入的技能；手写技能一律拒绝（插件不去删不是它放的东西） */
  async remove(session: FsSession, ref: string, confirm: boolean | undefined): Promise<ProjectSkill> {
    const skill = await this.resolveSkill(session, ref);
    if (!skill.imported) {
      throw new Error(
        `"${skill.name}" was not imported by novel_skill, so this tool will not delete it. ` +
          `It is a hand-written skill at ${skill.path} — remove that file yourself if you really mean to.`,
      );
    }
    if (confirm !== true) {
      throw new Error(
        `Removing skill "${skill.name}" deletes its files under the project's .dsh/skills directory. ` +
          "Ask the user first, then pass confirm=true.",
      );
    }
    if (skill.dir) await this.ops.removeDir(skill.dir, session);
    else await this.ops.removeFile(skill.file, session);
    return skill;
  }

  /**
   * 导出成技能包，便于分享。默认落在 `<dataDir>/skillpacks/` 下。
   *
   * **不覆盖已存在的文件**：`out_path` 是调用方（模型）可控的，默认覆盖意味着
   * `out_path=<工作区里任意 .json>` 就能用一份技能包把 project.json / chapters/index.json
   * 之类的数据文件无声盖掉，而且工具还报成功。与角色卡导出 PNG、正文导出同一套规矩。
   */
  async exportPack(
    session: FsSession,
    ref: string,
    outPath: string | undefined,
  ): Promise<{ pack: SkillPack; path: string }> {
    const skill = await this.resolveSkill(session, ref);
    const pack = await this.asPack([skill], session);
    const path = outPath?.trim() || join(this.dataDir, "skillpacks", `${skill.name}.json`);
    await this.ops.writeJson(path, pack, session, undefined, false);
    return { pack, path: (await this.ops.resolve(path, session)).displayPath };
  }
}
