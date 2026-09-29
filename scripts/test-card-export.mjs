// 验证角色卡导出链路：存储字段优先于 rawData、V1 字段不丢、头像与非 PNG 的处理，
// 以及「导入 → 改字段 → 导出 → 再导入」这条最该证、之前完全没有单测的往返路径。
//
// 与 test-card-import.mjs 一样：cardImport/export 是 TS 且用无扩展相对导入，
// 先经 esbuild 打包再测真代码。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outFile = join(mkdtempSync(join(tmpdir(), "nn-card-export-")), "bundle.mjs");
await esbuild.build({
  stdin: {
    contents:
      'export { buildCharacterPng, safeName } from "./src/domain/export";\n' +
      'export { parseCharacterBytes } from "./src/domain/cardImport";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
});
const { buildCharacterPng, parseCharacterBytes } = await import(pathToFileURL(outFile).href);

let failed = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(
    `${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (期望 ${JSON.stringify(expected)})`}`,
  );
};
const checkTrue = (label, value) => check(label, Boolean(value), true);

/** 从导出的 PNG 里读回 chara chunk 的 JSON */
function readChara(png) {
  const { parseTextChunk } = textChunkReader;
  return parseTextChunk(png, "chara");
}

// 直接复用 domain/png 的读取？——导出走 tEXt，这里用最小解析避免依赖内部实现
const textChunkReader = {
  parseTextChunk(png, keyword) {
    const buffer = Buffer.from(png);
    let offset = 8;
    while (offset < buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
      const data = buffer.subarray(offset + 8, offset + 8 + length);
      if (type === "tEXt") {
        const zero = data.indexOf(0);
        if (data.subarray(0, zero).toString("ascii") === keyword) {
          return JSON.parse(Buffer.from(data.subarray(zero + 1).toString("ascii"), "base64").toString("utf8"));
        }
      }
      offset += 12 + length;
    }
    return null;
  },
};

// ---- 1. V2 卡：存储字段是权威，rawData 只当未知键底本 ----
const v2 = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "旧名字",
    description: "旧描述",
    personality: "旧性格",
    first_mes: "旧开场",
    creator_notes: "旧备注",
    creator: "旧作者",
    character_version: "1.0",
    tags: ["旧标签"],
    extensions: { keepme: true },
  },
};
const stored = {
  name: "新名字",
  specVersion: "v2",
  rawData: JSON.stringify(v2),
  description: "新描述",
  personality: "新性格",
  scenario: "",
  firstMes: "新开场",
  mesExample: "",
  creatorNotes: "新备注",
  creator: "新作者",
};
console.log("--- V2 导出：存储字段优先 ---");
const v2Png = await buildCharacterPng(stored, null);
const v2Out = readChara(v2Png);
check("data.name 用存储值", v2Out.data.name, "新名字");
check("data.description 用存储值", v2Out.data.description, "新描述");
check("data.personality 用存储值", v2Out.data.personality, "新性格");
check("data.first_mes 用存储值", v2Out.data.first_mes, "新开场");
check("data.creator_notes 用存储值", v2Out.data.creator_notes, "新备注");
check("data.creator 用存储值", v2Out.data.creator, "新作者");
check("未知字段保留（rawData 底本）", v2Out.data.extensions.keepme, true);
check("character_version 保留原始值", v2Out.data.character_version, "1.0");
check("tags 保留", Array.isArray(v2Out.data.tags) && v2Out.data.tags[0], "旧标签");
check("spec 仍是 v2", v2Out.spec, "chara_card_v2");

// ---- 2. V1 卡：creator_notes / creator / character_version 不能再导出成空串 ----
const v1 = {
  name: "老张",
  description: "酒馆老板",
  personality: "爽利",
  scenario: "",
  first_mes: "客官里面请。",
  mes_example: "",
  creator_notes: "V1 就有的备注",
  creator: "V1 作者",
  character_version: "0.9",
  system_prompt: "V1 系统提示",
};
const v1Stored = {
  name: "老张",
  specVersion: "v1",
  rawData: JSON.stringify(v1),
  description: "酒馆老板",
  personality: "爽利",
  scenario: "",
  firstMes: "客官里面请。",
  mesExample: "",
  creatorNotes: "V1 就有的备注",
  creator: "V1 作者",
};
console.log("--- V1 导出：字段不丢 ---");
const v1Out = readChara(await buildCharacterPng(v1Stored, null));
check("V1 → V2 包装", v1Out.spec, "chara_card_v2");
check("creator_notes 保留", v1Out.data.creator_notes, "V1 就有的备注");
check("creator 保留", v1Out.data.creator, "V1 作者");
check("character_version 保留", v1Out.data.character_version, "0.9");
check("system_prompt 保留", v1Out.data.system_prompt, "V1 系统提示");
check("description 保留", v1Out.data.description, "酒馆老板");

// ---- 3. 导入 → 改字段 → 导出 → 再导入：编辑必须往返成功 ----
console.log("--- 往返：编辑后导出再导入 ---");
const cardJson = new TextEncoder().encode(
  JSON.stringify({
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: { name: "林晚", description: "冷面刺客", personality: "寡言", scenario: "", first_mes: "", mes_example: "" },
  }),
);
const imported = await parseCharacterBytes(cardJson, "linwan.json", "application/json");
check("导入得到原名", imported.character.name, "林晚");
const edited = {
  ...imported.character,
  name: "林晚（改）",
  description: "改过的描述",
};
const editedPng = await buildCharacterPng(edited, null);
const reimported = await parseCharacterBytes(
  new Uint8Array(editedPng),
  "linwan-roundtrip.png",
  "image/png",
);
check("往返后 name 是编辑后的值", reimported.character.name, "林晚（改）");
check("往返后 description 是编辑后的值", reimported.character.description, "改过的描述");
check("往返后 spec 仍是 v2", reimported.character.specVersion, "v2");
checkTrue("往返后头像字节带回来了", reimported.character.avatarBytes !== null);

// ---- 4. 非 PNG 头像 → 纯色占位图（仍然是合法 PNG） ----
console.log("--- 头像缺失 → 占位图 ---");
const placeholder = await buildCharacterPng(v2Stored(stored), null);
check("占位图仍是 PNG 签名", Buffer.from(placeholder).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
checkTrue("占位图仍能读回卡片", readChara(placeholder) !== null);

function v2Stored(character) {
  return character;
}

// ---- 5. 图片改名成 .json：按魔数走图片解析，不报「不是合法 JSON」 ----
console.log("--- 魔数嗅探 ---");
const webpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
try {
  await parseCharacterBytes(webpBytes, "card.json", "application/json");
  checkTrue("WebP 改名成 .json 时不应报 JSON 解析失败", false);
} catch (error) {
  checkTrue(
    "WebP 改名成 .json 时按图片解析（报的是卡片解析错误而非 JSON 错误）",
    !String(error.message).includes("不是合法的 JSON"),
  );
}

// ---- 6. JSON 卡头像是外链：明确报告，而不是静默变成占位图 ----
console.log("--- 外链头像 ---");
const urlAvatar = await parseCharacterBytes(
  new TextEncoder().encode(
    JSON.stringify({
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "外链角色",
        description: "d",
        personality: "",
        scenario: "",
        first_mes: "",
        mes_example: "",
        avatar: "https://example.com/a.png",
      },
    }),
  ),
  "url.json",
  "application/json",
);
check("外链头像没有字节", urlAvatar.character.avatarBytes, null);
checkTrue("外链头像有说明", Boolean(urlAvatar.character.avatarNote));

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
