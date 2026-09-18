/**
 * 技能：把插件自带的 SKILL.md 注册成运行时技能（rank 250）。
 *
 * 之所以不用 skill-filesystem 的 customSkillDirs：那是别的插件行的 config，
 * 从本包的 patch 覆盖它需要重述 dsh-base 的整份 config（patch 是整行替换），
 * 极易随上游变化失效。运行时注册自包含，且项目级技能（rank 100/200）仍能覆盖同名技能。
 *
 * 这里的 SKILL.md 与用户导入的技能包（novel_skill → 项目根 .dsh/skills/）共用同一份解析器
 * （domain/skillFrontmatter），区别只在投递方式：这些随包走，那些落在工作区里。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, SkillRegistration } from "./contract";
import { parseSkillFile, type SkillFrontmatter } from "./domain/skillFrontmatter";

const SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url));

interface BundledSkill {
  /** skills/ 下的目录名（出错信息用，与 frontmatter 的 name 不一定相同） */
  entry: string;
  dir: string;
  frontmatter: SkillFrontmatter;
  content: string;
}

/** 读取 skills/ 下的全部技能；缺失的目录或坏掉的单个技能只记警告并跳过 */
async function loadBundledSkills(warn: (message: string) => void): Promise<BundledSkill[]> {
  let entries: string[];
  try {
    entries = await readdir(SKILLS_DIR);
  } catch (error: unknown) {
    warn(`dsh-novelnovel: no skills directory (${(error as Error).message})`);
    return [];
  }
  const skills: BundledSkill[] = [];
  for (const entry of entries.sort()) {
    const dir = join(SKILLS_DIR, entry);
    const path = join(dir, "SKILL.md");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      // 目录里没有 SKILL.md：忽略（skills/ 下也可能放别的资源）
      continue;
    }
    try {
      const { frontmatter, content } = parseSkillFile(text, path);
      skills.push({ entry, dir, frontmatter, content });
    } catch (error: unknown) {
      warn(`dsh-novelnovel: skill "${entry}" not loaded (${(error as Error).message})`);
    }
  }
  return skills;
}

/** 插件自带技能的名字：novel_skill 用它提示项目技能会不会覆盖同名内置技能 */
export function bundledSkillNames(warn: (message: string) => void): Promise<string[]> {
  return loadBundledSkills(warn).then((skills) => skills.map((skill) => skill.frontmatter.name));
}

export async function registerSkills(ctx: Context): Promise<void> {
  const warn = (message: string): void => ctx.logger.warn(message);
  for (const { dir, frontmatter, content } of await loadBundledSkills(warn)) {
    const skill: SkillRegistration = {
      name: frontmatter.name,
      description: frontmatter.description,
      content,
      source: "runtime",
      resourceBase: { kind: "directory", path: dir },
      invocation: {
        modelInvocable: frontmatter.modelInvocable,
        userInvocable: frontmatter.userInvocable,
      },
      ...(frontmatter.whenToUse ? { whenToUse: frontmatter.whenToUse } : {}),
    };
    ctx.skills.register(skill);
    ctx.logger.debug(`dsh-novelnovel: skill "${frontmatter.name}" registered`);
  }
}
