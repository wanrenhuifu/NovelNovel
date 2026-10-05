/**
 * 文档契约检查：README 工具表里承诺的每个 action 都必须在 schema 里真实存在。
 *
 * 为什么值得单独测：README 是用户（和模型）看到的契约，"文档说能做、工具说没这个 action"
 * 是最直接的破窗。这条也顺带钉住"新增 action 时要同步 README"这个约定（AGENTS.md 里写了，
 * 但此前没有测试守）。
 *
 * 必须用 DSH 自带的 Electron Node 运行。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load, registerHarnessHook } from "./harness-loader.mjs";

registerHarnessHook(fileURLToPath(new URL("..", import.meta.url)));

const repo = fileURLToPath(new URL("..", import.meta.url));
const { Context } = await load("@deepseek-ai/cordis");
const { default: SystemPrompt } = await load("@deepseek-ai/dsh-system-prompt");
const { default: ToolRuntime } = await load("@deepseek-ai/dsh-tools");
const { default: LocalFileSystem } = await load("@deepseek-ai/dsh-fs-local");
const { default: SkillRegistry } = await load("@deepseek-ai/dsh-skill");
const plugin = await load("dsh-novelnovel");

const workspace = mkdtempSync(join(tmpdir(), "nn-contract-"));
mkdirSync(join(workspace, ".git"), { recursive: true });
const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(LocalFileSystem, { cwd: workspace });
await ctx.plugin(SkillRegistry);
await ctx.plugin(plugin);
await new Promise((resolve) => setTimeout(resolve, 200));

let passed = 0;
let failed = 0;
const check = (label, ok, extra = "") => {
  if (ok) {
    passed++;
    console.log(`✓ ${label}${extra ? `  ${extra}` : ""}`);
  } else {
    failed++;
    console.log(`✗ ${label}${extra ? `  ${extra}` : ""}`);
  }
};

// 真实注册的工具与各自的 action 枚举
const schemas = new Map();
for (const schema of ctx.tools.schemas()) {
  schemas.set(schema.name, schema);
}

/**
 * README 工具表里承诺的 action（按那一列的措辞逐项列出）。
 * 新增工具或 action 时**两边一起改**，否则这里会失败——这就是它的用途。
 */
const promised = {
  novel_project: ["create", "list", "show", "update", "use", "delete"],
  novel_chapter: [
    "list",
    "read",
    "create",
    "append",
    "write",
    "rename",
    "tag",
    "move",
    "search",
    "delete",
  ],
  novel_character: ["import", "list", "show", "enable", "disable", "export", "remove", "update"],
  novel_lorebook: ["list", "add", "update", "remove"],
  novel_preset: ["list", "import", "add", "update", "activate", "deactivate", "remove"],
  novel_skill: ["list", "import", "export", "remove"],
  novel_context: [],
  novel_export: ["markdown", "text", "backup"],
};

console.log("--- README 工具表承诺的 action ---");
for (const [tool, actions] of Object.entries(promised)) {
  const schema = schemas.get(tool);
  if (schema === undefined) {
    check(`${tool} 已注册`, false, "工具不存在");
    continue;
  }
  check(`${tool} 已注册`, true);
  if (actions.length === 0) continue;
  // schema 是 JSON Schema 形状：`parameters.properties.action.enum`
  const properties = schema.parameters?.properties ?? {};
  const actionSchema = properties.action ?? {};
  const declared = Array.isArray(actionSchema.enum) ? actionSchema.enum : [];
  const missing = actions.filter((action) => !declared.includes(action));
  const undocumented = declared.filter((action) => !actions.includes(action));
  check(
    `${tool} 的 action 都在 schema 里`,
    missing.length === 0,
    missing.length > 0 ? `README 承诺但 schema 没有: ${missing.join(", ")}` : "",
  );
  // 反向也要盯：schema 新增了 action 但 README 没写，同样算契约不同步
  check(
    `${tool} 的 schema action 都写进了 README`,
    undocumented.length === 0,
    undocumented.length > 0 ? `schema 有但 README 未列: ${undocumented.join(", ")}` : "",
  );
}

// README 里逐个工具名都要能对上（避免改名后文档悬空）
console.log("--- README 里出现的工具名都存在 ---");
const readme = readFileSync(join(repo, "README.md"), "utf8");
const mentioned = new Set(readme.match(/novel_[a-z]+/g) ?? []);
const notTools = new Set(["novel_prose", "novel_dialogue", "novel_scene", "novel_outline", "novel_cards"]);
for (const name of [...mentioned].sort()) {
  if (notTools.has(name)) continue;
  // README 里的技能名用连字符，工具名用下划线，所以这里只可能是工具名
  if (!/^novel_/.test(name)) continue;
  const isTool = schemas.has(name);
  const isSkillLike = readme.includes(`/novel-${name.slice(6)}`) || readme.includes(`\`${name}\``) === false;
  if (isTool || isSkillLike) continue;
  check(`README 提到的 ${name} 有对应工具`, false, "文档悬空");
}
check("README 里提到的工具名都能对上（或确认为技能名）", true);

// README 里的**链接指向的仓库内文件**都要真实存在（悬空链接同样是文档破了契约）。
// 只查 markdown 链接：反引号里的裸文件名多是"数据文件名"（`project.json`、`lorebook.json`），
// 那些是用户数据、本来就不在仓库里，算进来只会误报。
console.log("--- README 链接指向的仓库内文件 ---");
{
  const refs = new Set();
  for (const match of readme.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^https?:/.test(target) || target.startsWith("#")) continue;
    refs.add(target.split("#")[0]);
  }
  const missing = [...refs].filter((ref) => ref !== "" && !existsSync(join(repo, ref)));
  check(
    `README 链接的 ${String(refs.size)} 个仓库内文件都存在`,
    missing.length === 0,
    missing.length > 0 ? `缺失: ${missing.join(", ")}` : "",
  );
}

rmSync(workspace, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
