/**
 * SKILL.md 的 frontmatter 解析与渲染，以及 harness 的技能名规范。
 *
 * 插件自带技能（src/skills.ts，构建期就在包里的 skills/）与用户导入的技能包
 * （domain/skillPack.ts，运行时由 novel_skill 落盘）共用这一份逻辑——两条路径必须对
 * 同一个文件的解释完全一致，否则「导入时通过、加载时消失」这类问题无从排查。
 */

/**
 * harness 的技能名规范（packages/skill/skill-filesystem 的 `^[a-z0-9]+(?:-[a-z0-9]+)*$`）。
 * 不合规的候选会被本地 provider 判为 malformed 而丢掉，所以这里必须**在写盘前**拦住。
 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillFrontmatter {
  name: string;
  description: string;
  whenToUse?: string;
  /** 由 `disable-model-invocation` 取反得到（harness 的正向化语义） */
  modelInvocable: boolean;
  /** 由 `user-invocable` 得到；两者缺省都是 true */
  userInvocable: boolean;
}

export interface ParsedSkillFile {
  frontmatter: SkillFrontmatter;
  /** frontmatter 之后的正文（已 trim） */
  content: string;
}

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

/** 解掉 YAML 引号：frontmatter 是手写的，单双引号都容忍 */
function unquote(value: string | undefined): string {
  return (value ?? "").replace(/^["']|["']$/g, "").trim();
}

/**
 * 解析 SKILL.md 的 frontmatter（只认本插件用到的字段）。
 * `disable-model-invocation` / `user-invocable` 与 harness 的语义一致：
 * 前者 true ⇒ 不对模型可见，后者 false ⇒ 不对用户可见。
 *
 * source 是出错信息里用来定位的标签——插件技能传文件路径，技能包传 `包名#技能名`。
 */
export function parseSkillFile(text: string, source: string): ParsedSkillFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) throw new Error(`skill file has no frontmatter: ${source}`);
  const data = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    data.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const name = unquote(data.get("name"));
  const description = unquote(data.get("description"));
  if (!name) throw new Error(`skill file is missing a name: ${source}`);
  if (!isValidSkillName(name)) {
    throw new Error(
      `skill name "${name}" is not kebab-case (${source}): use lowercase letters, digits and single hyphens, e.g. "web-novel-pacing"`,
    );
  }
  if (!description) throw new Error(`skill ${name} is missing a description: ${source}`);
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

/** 解析与渲染共用的字段形状（技能包里的一个技能） */
export interface SkillFileFields {
  name: string;
  description: string;
  whenToUse?: string;
  modelInvocable?: boolean;
  userInvocable?: boolean;
  content: string;
}

/**
 * 渲染成 SKILL.md。两个 invocation 开关只在偏离默认（都可见）时写出，
 * 这样手写的普通技能与导入产物长得一样。
 */
export function renderSkillFile(skill: SkillFileFields): string {
  const frontmatter = [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    ...(skill.whenToUse ? [`whenToUse: ${skill.whenToUse}`] : []),
    ...(skill.modelInvocable === false ? ["disable-model-invocation: true"] : []),
    ...(skill.userInvocable === false ? ["user-invocable: false"] : []),
    "---",
  ];
  return `${frontmatter.join("\n")}\n\n${skill.content.trim()}\n`;
}
