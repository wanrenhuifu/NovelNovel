/**
 * 技能：把插件自带的 SKILL.md 注册成运行时技能（rank 250）。
 *
 * 之所以不用 skill-filesystem 的 customSkillDirs：那是别的插件行的 config，
 * 从本包的 patch 覆盖它需要重述 dsh-base 的整份 config（patch 是整行替换），
 * 极易随上游变化失效。运行时注册自包含，且项目级技能（rank 100/200）仍能覆盖同名技能。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, SkillRegistration } from "./contract";

const SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url));

interface SkillFrontmatter {
  name: string;
  description: string;
  whenToUse?: string;
  modelInvocable: boolean;
  userInvocable: boolean;
}

/**
 * 解析 SKILL.md 的 frontmatter（只认本插件用到的字段）。
 * `disable-model-invocation` / `user-invocable` 与 harness 的语义一致：
 * 前者 true ⇒ 不对模型可见，后者 false ⇒ 不对用户可见。
 */
export function parseSkillFile(text: string, path: string): { frontmatter: SkillFrontmatter; content: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) throw new Error(`skill file has no frontmatter: ${path}`);
  const data = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    data.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const unquote = (value: string | undefined): string =>
    (value ?? "").replace(/^["']|["']$/g, "").trim();
  const name = unquote(data.get("name"));
  const description = unquote(data.get("description"));
  if (!name) throw new Error(`skill file is missing a name: ${path}`);
  if (!description) throw new Error(`skill ${name} is missing a description: ${path}`);
  const bool = (key: string, fallback: boolean): boolean => {
    const value = data.get(key)?.toLowerCase();
    if (value === undefined) return fallback;
    if (["true", "yes", "on", "1"].includes(value)) return true;
    if (["false", "no", "off", "0"].includes(value)) return false;
    throw new Error(`skill ${name}: ${key} must be a boolean`);
  };
  const whenToUse = unquote(data.get("whenToUse"));
  return {
    frontmatter: {
      name,
      description,
      ...(whenToUse ? { whenToUse } : {}),
      modelInvocable: !bool("disable-model-invocation", false),
      userInvocable: bool("user-invocable", true),
    },
    content: text.slice(match[0].length).trim(),
  };
}

/** 注册 skills/ 目录下的全部技能；某个技能坏了只记警告，不影响其余技能与工具 */
export async function registerSkills(ctx: Context): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(SKILLS_DIR);
  } catch (error: unknown) {
    ctx.logger.warn(`dsh-novelnovel: no skills directory (${(error as Error).message})`);
    return;
  }
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
    } catch (error: unknown) {
      ctx.logger.warn(`dsh-novelnovel: skill "${entry}" not loaded (${(error as Error).message})`);
    }
  }
}
