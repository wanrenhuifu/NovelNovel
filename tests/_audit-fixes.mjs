// 核对本轮修复是否真的落在代码里（避免"我改过了"变成口头账）
import { readFileSync } from "node:fs";

const checks = [
  ["A1 skill 导出不覆盖", "src/skillStore.ts", "writeJson(path, pack, session, undefined, false)"],
  ["A2 符号链接闸", "src/fsx.ts", "realParentInsideWorkspace"],
  ["A2b realpath 判据", "src/fsx.ts", "safeRealpath"],
  ["B1 章节引用先标题后序号", "src/store.ts", "if (ordinal !== null && partial.length === 0)"],
  ["B4 空引用可读报错", "src/store.ts", "chapter reference is empty"],
  ["B2 词条删除 confirm", "src/tools/lorebook.ts", "confirm !== true"],
  ["B2b 预设删除 confirm", "src/tools/preset.ts", "confirm !== true"],
  ["B5 toggle/enabled 冲突", "src/tools/lorebook.ts", "not both"],
  ["C3 updateProject 带基准", "src/store.ts", "readJsonVersioned<NovelProject>"],
  ["C1 moveChapter 单次读", "src/store.ts", "const { index, basis } = await this.readChapterIndexVersioned"],
  ["C3b writeChapterBody 自取基准", "src/store.ts", "readChapterBodyVersioned(session, projectId, chapterId)"],
  ["C4 孤儿索引闸", "src/store.ts", "assertNoOrphanChapters"],
  ["C4b writeChapterIndex 内调用", "src/store.ts", "this.assertNoOrphanChapters(index, known, projectId)"],
  ["C9 createProject 占用检查", "src/store.ts", "this.ops.writeJson(this.projectFile(id), project, session, undefined, false)"],
  ["C6 importCharacter 统一回滚", "src/store.ts", "const rollback = async"],
  ["D1 ccv3 复用合并 data", "src/domain/export.ts", "data: v2Spec.data"],
  ["D2 character_card 清理", "src/domain/export.ts", "CARD_KEYWORDS"],
  ["D3 V2 按形状判定", "src/domain/cardImport.ts", "function v2Payload"],
  ["D3b 字段 raw 优先", "src/domain/cardImport.ts", "const field = (key: string, fromLib: unknown)"],
  ["D4 哨兵过滤", "src/domain/cardImport.ts", "function realText"],
  ["D5 世界书三层查找", "src/domain/cardImport.ts", "function usableBook"],
  ["D6 PNG 占位兜底", "src/domain/export.ts", "return await placeholder()"],
  ["D7 裸预设合并", "src/domain/presetImport.ts", 'storyString.trim() !== ""'],
  ["D8 宏替换转义", "src/domain/prompt.ts", "() => charName"],
  ["D11 BOM 切片", "src/domain/skillFrontmatter.ts", "content: body.slice(match[0].length)"],
  ["D9 码点切片", "src/domain/search.ts", "function sliceByCodePoint"],
  ["D10 ZWJ 剥离", "src/domain/utils.ts", "JOINERS"],
];

let ok = 0;
const missing = [];
for (const [label, file, needle] of checks) {
  const text = readFileSync(file, "utf8");
  if (text.includes(needle)) ok++;
  else missing.push(`${label}  (${file})`);
}
console.log(`已落地: ${ok}/${checks.length}`);
if (missing.length > 0) {
  console.log("未确认:");
  for (const m of missing) console.log(`  ✗ ${m}`);
}
