/**
 * 技能包（JSON）的解析与序列化。
 *
 * 技能包只是**导入格式**，不是存储格式：落盘后由 harness 自己的技能目录扫描消费
 * （项目根 `.dsh/skills/`，rank 100），每个技能最终都以 SKILL.md 存在。
 * 这样导入的技能与用户手写的技能走完全相同的加载路径，插件不维护第二套技能机制。
 *
 * 两种形状（按 `skills` 是否存在区分，与 presetImport 的「裸对象 / 信封」同一套路）：
 * - 信封：{ name, author?, version?, skills: [ { name, description, whenToUse?, content } ] }
 * - 单技能：{ name, description, whenToUse?, content }，此时 name 就是技能名（必须 kebab-case）
 */
import { isValidSkillName, parseSkillFile, renderSkillFile, type SkillFileFields } from "./skillFrontmatter";

export interface PackedSkill extends SkillFileFields {}

export interface SkillPack {
  /** 包名（给人看的展示名，可含中文；不参与落盘路径） */
  name: string;
  author?: string;
  version?: string;
  skills: PackedSkill[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, where: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${where}: ${field} must be a non-empty string`);
  }
  return value.trim();
}

/** frontmatter 是逐行 `key: value` 解析的，值里混进换行会静默毁掉后面所有字段 */
function requireSingleLine(value: string, field: string, where: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${where}: ${field} must fit on one line (the SKILL.md frontmatter is line-based)`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string, where: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${where}: ${field} must be true or false`);
  return value;
}

function parsePackedSkill(value: unknown, where: string): PackedSkill {
  if (!isRecord(value)) throw new Error(`${where}: each skill must be a JSON object`);
  const name = requireString(value.name, "name", where);
  if (!isValidSkillName(name)) {
    throw new Error(
      `${where}: skill name "${name}" is not kebab-case — use lowercase letters, digits and single hyphens, e.g. "web-novel-pacing"`,
    );
  }
  const description = requireSingleLine(requireString(value.description, "description", where), "description", where);
  const content = requireString(value.content, "content", where);
  const whenToUse = value.whenToUse === undefined
    ? undefined
    : requireSingleLine(requireString(value.whenToUse, "whenToUse", where), "whenToUse", where);
  const modelInvocable = optionalBoolean(value.modelInvocable, "modelInvocable", where);
  const userInvocable = optionalBoolean(value.userInvocable, "userInvocable", where);
  return {
    name,
    description,
    ...(whenToUse ? { whenToUse } : {}),
    ...(modelInvocable === undefined ? {} : { modelInvocable }),
    ...(userInvocable === undefined ? {} : { userInvocable }),
    content,
  };
}

/**
 * 解析一份技能包 JSON。任何不合规都在这里抛出中文说明——
 * 导入必须**先全部校验再落盘**，不能写一半才发现第 3 个技能名非法。
 */
export function parseSkillPack(text: string): SkillPack {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("技能包解析失败：内容不是合法的 JSON");
  }
  if (!isRecord(json)) throw new Error("技能包应是一个 JSON 对象");

  const name = json.name === undefined ? "" : requireSingleLine(requireString(json.name, "name", "技能包"), "name", "技能包");
  const author = json.author === undefined ? undefined : requireString(json.author, "author", "技能包");
  const version = json.version === undefined ? undefined : requireString(json.version, "version", "技能包");

  const raw = json.skills;
  if (raw === undefined) {
    // 单技能形状：顶层对象本身就是一个技能
    const skill = parsePackedSkill(json, "技能包");
    return { name: name || skill.name, ...(author ? { author } : {}), ...(version ? { version } : {}), skills: [skill] };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("技能包解析失败：skills 应是非空数组（也可以去掉 skills，把单个技能写在顶层）");
  }

  const skills = raw.map((entry, index) => parsePackedSkill(entry, `技能包第 ${index + 1} 个技能`));
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.name)) throw new Error(`技能包里有重名技能："${skill.name}"`);
    seen.add(skill.name);
  }
  return { name: name || skills[0].name, ...(author ? { author } : {}), ...(version ? { version } : {}), skills };
}

/**
 * 把落盘的技能重新打包，便于分享（与 parseSkillPack 同一个格式）。
 *
 * 导出侧必须做与导入侧**对称**的校验：导入坚持「先全量校验再落盘」，
 * 导出却放行 `content: "   "` 的话，会做出一个自己的 parseSkillPack 立刻拒绝的包
 * ——分享出去谁也导不回来。
 */
export function buildSkillPack(
  meta: { name: string; author?: string; version?: string },
  skills: PackedSkill[],
): SkillPack {
  if (skills.length === 0) {
    throw new Error("技能包至少要有一个技能");
  }
  for (const skill of skills) {
    if (!isValidSkillName(skill.name)) {
      throw new Error(
        `技能名 "${skill.name}" 不是 kebab-case，导出后 harness 会拒绝加载`,
      );
    }
    if (!skill.description.trim()) {
      throw new Error(`技能 "${skill.name}" 缺少 description（模型唯一能看到的字段）`);
    }
    if (!skill.content.trim()) {
      throw new Error(`技能 "${skill.name}" 的正文是空的，导出后无法导回`);
    }
  }
  return {
    name: meta.name,
    ...(meta.author ? { author: meta.author } : {}),
    ...(meta.version ? { version: meta.version } : {}),
    skills,
  };
}

/**
 * 渲染并立即回读一次，确认产物能被同一套解析器读出来。
 * 只在导入路径上跑：手写的技能文件坏了是用户自己的事，插件生成的必须自证。
 * 回读要比对**所有关键字段**，只比 name 会让引号、多行值这类损坏静默通过。
 */
export function renderPackedSkill(skill: PackedSkill): string {
  const text = renderSkillFile(skill);
  const reread = parseSkillFile(text, skill.name);
  const { frontmatter } = reread;
  if (frontmatter.name !== skill.name) {
    throw new Error(`技能 "${skill.name}" 渲染后回读不一致（name），已中止导入`);
  }
  if (frontmatter.description !== skill.description) {
    throw new Error(
      `技能 "${skill.name}" 渲染后回读不一致（description）：请检查描述里是否有换行或首尾引号`,
    );
  }
  if ((frontmatter.whenToUse ?? "") !== (skill.whenToUse ?? "")) {
    throw new Error(
      `技能 "${skill.name}" 渲染后回读不一致（whenToUse）：请检查该字段是否有换行或首尾引号`,
    );
  }
  if (reread.content.trim() !== skill.content.trim()) {
    throw new Error(`技能 "${skill.name}" 渲染后回读不一致（正文），已中止导入`);
  }
  return text;
}

/**
 * 目录的祖先链（含自身，从近到远）。
 *
 * harness 的项目根是「最近的含 .git 的祖先目录，没有则用 cwd」，技能根就挂在它下面。
 * 直接写 `<cwd>/.dsh/skills` 在子目录里开的会话会写到一个没人扫的地方——所以要能往上走。
 * 纯字符串运算：不碰文件系统，`\` 与 `/` 都容忍（会话路径来自宿主，形式不定）。
 */
export function ancestorDirs(startDir: string): string[] {
  const start = startDir.replace(/[\\/]+$/, "") || startDir;
  const absolute = /^[\\/]/.test(start) || /^[a-zA-Z]:/.test(start);
  const dirs: string[] = [];
  let current = start;
  while (current) {
    dirs.push(current);
    if (current === "/" || /^[a-zA-Z]:$/.test(current)) break;
    const parent = current.replace(/[\\/][^\\/]*$/, "");
    // 没有可截的父目录：单段相对路径（"proj"）已到头
    if (parent === current) break;
    if (!parent) {
      if (absolute) dirs.push("/");
      break;
    }
    current = parent;
  }
  return dirs;
}
