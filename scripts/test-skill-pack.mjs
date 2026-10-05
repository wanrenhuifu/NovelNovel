// 技能包与 SKILL.md frontmatter 纯逻辑测试
// 源码用无扩展相对导入（Vite 风格），Node 直跑 TS 不认，先经 esbuild 打包到临时文件再测真代码
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "nn-skillpack-"));
const outFile = join(dir, "bundle.mjs");
await esbuild.build({
  stdin: {
    contents: [
      'export { parseSkillPack, buildSkillPack, renderPackedSkill, ancestorDirs } from "./src/domain/skillPack";',
      'export { parseSkillFile, renderSkillFile, isValidSkillName } from "./src/domain/skillFrontmatter";',
    ].join("\n"),
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
});
const {
  parseSkillPack,
  buildSkillPack,
  renderPackedSkill,
  ancestorDirs,
  parseSkillFile,
  renderSkillFile,
  isValidSkillName,
} = await import(pathToFileURL(outFile).href);
rmSync(dir, { recursive: true, force: true });

let failed = 0;
function check(label, ok, extra = "") {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` ${extra}` : ""}`);
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 断言某次调用抛错，且错误信息里含某段文字 */
function throws(label, fn, needle) {
  try {
    fn();
    check(label, false, "(did not throw)");
  } catch (error) {
    const ok = !needle || error.message.includes(needle);
    check(label, ok, ok ? "" : `(message was: ${error.message})`);
  }
}

// ── 技能名规范 ────────────────────────────────────────────────────────────
check("kebab-case accepted", isValidSkillName("web-novel-pacing"));
check("digits accepted", isValidSkillName("level2-arc"));
check("uppercase rejected", !isValidSkillName("Web-Novel"));
check("underscore rejected", !isValidSkillName("web_novel"));
check("leading hyphen rejected", !isValidSkillName("-web"));
check("double hyphen rejected", !isValidSkillName("web--novel"));
check("CJK rejected", !isValidSkillName("网文"));

// ── 信封形状 ──────────────────────────────────────────────────────────────
const envelope = parseSkillPack(
  JSON.stringify({
    name: "网文爽点写作法",
    author: "someone",
    version: "1.2.0",
    skills: [
      { name: "pacing-beats", description: "Satisfaction beats.", content: "# Beats\n\nBody." },
      {
        name: "hook-endings",
        description: "Chapter-end hooks.",
        whenToUse: "断章",
        modelInvocable: true,
        userInvocable: false,
        content: "# Hooks\n\nBody.",
      },
    ],
  }),
);
check("envelope: pack name kept", envelope.name === "网文爽点写作法");
check("envelope: metadata kept", envelope.author === "someone" && envelope.version === "1.2.0");
check("envelope: skill count", envelope.skills.length === 2);
check("envelope: whenToUse kept", envelope.skills[1].whenToUse === "断章");
check("envelope: userInvocable kept", envelope.skills[1].userInvocable === false);
check(
  "envelope: omitted invocation stays undefined",
  envelope.skills[0].modelInvocable === undefined && envelope.skills[0].userInvocable === undefined,
);

// 单技能形状：顶层对象本身就是技能
const single = parseSkillPack(
  JSON.stringify({ name: "scene-turn", description: "Turn the scene.", content: "# Turn\n\nBody." }),
);
check("single: one skill", single.skills.length === 1);
check("single: name is the skill name", single.name === "scene-turn");
check("single: content kept", single.skills[0].content.includes("Body."));

// ── 错误路径：导入必须在校验阶段就拦住，不能写一半再失败 ───────────────────
throws("bad JSON rejected", () => parseSkillPack("{nope"), "不是合法的 JSON");
throws("array rejected", () => parseSkillPack("[]"), "应是一个 JSON 对象");
throws("empty skills rejected", () => parseSkillPack('{"skills":[]}'), "非空数组");
throws(
  "non-kebab skill name rejected",
  () => parseSkillPack(JSON.stringify({ skills: [{ name: "网文", description: "d", content: "c" }] })),
  "not kebab-case",
);
throws(
  "missing description rejected",
  () => parseSkillPack(JSON.stringify({ skills: [{ name: "ok-name", content: "c" }] })),
  "description must be a non-empty string",
);
throws(
  "missing content rejected",
  () => parseSkillPack(JSON.stringify({ skills: [{ name: "ok-name", description: "d" }] })),
  "content must be a non-empty string",
);
throws(
  "duplicate names rejected",
  () =>
    parseSkillPack(
      JSON.stringify({
        skills: [
          { name: "same-name", description: "d", content: "c" },
          { name: "same-name", description: "d", content: "c" },
        ],
      }),
    ),
  "重名技能",
);
// frontmatter 是逐行解析的：值里混进换行会静默毁掉后面所有字段，所以必须在导入时就拦住
throws(
  "multi-line description rejected",
  () =>
    parseSkillPack(
      JSON.stringify({ skills: [{ name: "ok-name", description: "line one\nline two", content: "c" }] }),
    ),
  "must fit on one line",
);
throws(
  "non-boolean invocation rejected",
  () =>
    parseSkillPack(
      JSON.stringify({
        skills: [{ name: "ok-name", description: "d", content: "c", modelInvocable: "yes" }],
      }),
    ),
  "must be true or false",
);

// ── 渲染 + 回读：插件生成的产物必须能被同一套解析器读回来 ────────────────────
const rendered = renderPackedSkill({
  name: "hook-endings",
  description: "Chapter-end hooks.",
  whenToUse: "断章",
  userInvocable: false,
  content: "# Hooks\n\nBody line.",
});
// 两个 invocation 开关只在偏离默认时写出，手写技能与导入产物长得一样
check("render: no model flag when default", !rendered.includes("disable-model-invocation"));
check("render: user-invocable written when false", rendered.includes("user-invocable: false"));
check("render: body kept", rendered.includes("Body line."));

const reread = parseSkillFile(rendered, "hook-endings");
check("round trip: name", reread.frontmatter.name === "hook-endings");
check("round trip: whenToUse", reread.frontmatter.whenToUse === "断章");
check("round trip: modelInvocable default true", reread.frontmatter.modelInvocable === true);
check("round trip: userInvocable false", reread.frontmatter.userInvocable === false);
check("round trip: content trimmed", reread.content === "# Hooks\n\nBody line.");

// 默认开关不写出 ⇒ 解析回来仍是双可见
const plain = parseSkillFile(renderSkillFile({ name: "plain-skill", description: "d", content: "c" }), "p");
check("round trip: defaults stay visible", plain.frontmatter.modelInvocable && plain.frontmatter.userInvocable);

// 导出包再导入：分享出去的包必须能原样导回
const repacked = parseSkillPack(JSON.stringify(buildSkillPack({ name: "p", version: "1" }, [envelope.skills[1]])));
check(
  "export → import keeps the skill",
  repacked.skills[0].name === "hook-endings" && repacked.skills[0].userInvocable === false,
);

// ── frontmatter 解析：手写文件的容错 ────────────────────────────────────────
throws("missing frontmatter rejected", () => parseSkillFile("# no frontmatter", "x.md"), "no frontmatter");
check(
  "quoted values unquoted",
  parseSkillFile('---\nname: "a-b"\ndescription: \'d\'\n---\nbody', "x.md").frontmatter.name === "a-b",
);
check(
  "boolean aliases accepted",
  parseSkillFile("---\nname: a-b\ndescription: d\ndisable-model-invocation: no\n---\nb", "x.md").frontmatter
    .modelInvocable === true,
);
// 冒号出现在值里是合法的：只按行的第一个冒号切分
check(
  "colon inside value kept",
  parseSkillFile("---\nname: a-b\ndescription: Use when: the user asks.\n---\nb", "x.md").frontmatter
    .description === "Use when: the user asks.",
);

// ── 项目根探测：harness 取「最近的含 .git 的祖先目录，没有则 cwd」 ────────────
check(
  "windows path walks up to the drive",
  eq(ancestorDirs("C:\\Users\\a\\proj"), ["C:\\Users\\a\\proj", "C:\\Users\\a", "C:\\Users", "C:"]),
);
check("trailing separator ignored", eq(ancestorDirs("C:\\Users\\a\\proj\\"), ancestorDirs("C:\\Users\\a\\proj")));
check("posix path walks up to the root", eq(ancestorDirs("/home/u/proj"), ["/home/u/proj", "/home/u", "/home", "/"]));
check("posix one level deep", eq(ancestorDirs("/proj"), ["/proj", "/"]));
check("forward slashes on windows tolerated", eq(ancestorDirs("C:/a/b"), ["C:/a/b", "C:/a", "C:"]));
// 相对路径不该凭空造出一个根：越界到盘根会让 .git 探测扫到无关目录
check("relative path stops at itself", eq(ancestorDirs("proj/sub"), ["proj/sub", "proj"]));
check("single relative segment terminates", eq(ancestorDirs("proj"), ["proj"]));
// 走到根就要停：早年这里漏了终止条件，单段路径会死循环
check("posix root terminates", eq(ancestorDirs("/"), ["/"]));

// BOM 下切正文：match 是在剥掉 BOM 的 body 上求出来的，若拿原文 text 去 slice 会整体偏移
// 一个字符。平时被 trim 吃掉，只有 frontmatter 之后没有换行时才暴露（正文变成 "-"）。
// 用 fromCharCode 构造 BOM：直接写转义在打包后可能被再次处理，容易把测试本身搞错。
const bom = String.fromCharCode(0xfeff);
const bomNoTrailingNewline = `${bom}---\nname: bom-skill\ndescription: d\n---`;
const bomParsed = parseSkillFile(bomNoTrailingNewline, "bom/SKILL.md");
check(
  "BOM 且无尾换行时正文为空（而不是残留一个 '-'）",
  JSON.stringify(bomParsed.content),
  '""',
);

const bomWithBody = `${bom}---\nname: bom-skill\ndescription: d\n---\n真正的正文`;
check("BOM 下正文不偏移", parseSkillFile(bomWithBody, "bom/SKILL.md").content, "真正的正文");

console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
process.exit(failed ? 1 : 0);
