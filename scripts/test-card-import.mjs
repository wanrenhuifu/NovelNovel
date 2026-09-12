// 验证角色卡解析链路：构造内嵌角色卡数据的 PNG + JSON，跑 char-card-reader 解析
// cardImport.ts 有无扩展相对导入（Vite 风格），Node 直跑不认，先经 esbuild 打包再测真代码
import { deflateSync } from "node:zlib";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CharacterCard } from "@lenml/char-card-reader";
import esbuild from "esbuild";

const outFile = join(mkdtempSync(join(tmpdir(), "nn-card-")), "bundle.mjs");
await esbuild.build({
  stdin: {
    contents:
      'export { extractLorebookEntries, parseCharacterBytes } from "./src/domain/cardImport";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
});
const { extractLorebookEntries, parseCharacterBytes } = await import(
  pathToFileURL(outFile).href
);

// ---- 手工构造 PNG ----
const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function makePngWithCard(cardJson, keyword = "chara") {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // 8bit RGBA
  const idat = deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  const textData = Buffer.concat([
    Buffer.from(`${keyword}\0`, "ascii"),
    Buffer.from(Buffer.from(cardJson, "utf8").toString("base64"), "ascii"),
  ]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("tEXt", textData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const v2Card = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "林晚",
    description: "{{char}}是一位冷面女刺客，擅长潜行与暗杀。",
    personality: "冷静、寡言、重情义",
    scenario: "深夜的屋顶，{{user}}被她堵住了去路。",
    first_mes: "别动。",
    mes_example: "<START>\n{{user}}: 你是谁？\n{{char}}: 不需要知道。",
    creator_notes: "测试卡片",
    creator: "test",
    character_version: "1.0",
    tags: ["武侠"],
    extensions: {},
    character_book: {
      entries: [
        { keys: ["影阁"], content: "影阁是江湖第一杀手组织。", extensions: {}, enabled: true, insertion_order: 0 },
      ],
      extensions: {},
    },
  },
};

const v3Card = {
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: { ...v2Card.data, nickname: "晚晚", group_only_greetings: [] },
};

let failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (期望 ${JSON.stringify(expected)})`}`);
}

// 1. PNG 内嵌 V2
const pngV2 = makePngWithCard(JSON.stringify(v2Card));
const card1 = await CharacterCard.from_file(new Uint8Array(pngV2));
console.log("--- PNG + V2 ---");
check("name", card1.name, "林晚");
check("spec", card1.spec, "chara_card_v2");
check("personality", card1.personality, "冷静、寡言、重情义");
check("lorebook entries", card1.character_book?.entries?.length ?? 0, 1);

// 2. PNG 双写（chara + ccv3），应优先 ccv3
const pngDual = Buffer.concat([
  makePngWithCard(JSON.stringify(v2Card)).subarray(0, makePngWithCard(JSON.stringify(v2Card)).length - 12),
  chunk("tEXt", Buffer.concat([
    Buffer.from("ccv3\0", "ascii"),
    Buffer.from(Buffer.from(JSON.stringify(v3Card), "utf8").toString("base64"), "ascii"),
  ])),
  chunk("IEND", Buffer.alloc(0)),
]);
const card2 = await CharacterCard.from_file(new Uint8Array(pngDual));
console.log("--- PNG 双写 (ccv3 优先) ---");
check("spec", card2.spec, "chara_card_v3");
check("nickname", card2.toSpecV3().data.nickname, "晚晚");

// 3. 纯 JSON（from_json 走 cardImport 的同一路径）
const card3 = CharacterCard.from_json(JSON.parse(JSON.stringify(v2Card)));
console.log("--- JSON 导入 ---");
check("name", card3.name, "林晚");
check("first_mes", card3.first_message, "别动。");

// 4. V1 顶层格式
const v1Card = { name: "老张", description: "酒馆老板", personality: "", scenario: "", first_mes: "客官里面请。", mes_example: "" };
const card4 = CharacterCard.from_json(v1Card);
console.log("--- JSON V1 ---");
check("name", card4.name, "老张");
// char-card-reader 对 V1 顶层格式把 spec 标为 "unknown"；
// 应用里的 specToVersion 会把非 v2/v3 一律归为 "v1"，行为正确。
check("spec (库内部标记)", card4.spec, "unknown");

// 5. 世界书提取：extractLorebookEntries
console.log("--- 世界书提取 ---");
const lore1 = extractLorebookEntries(card1);
check("提取条数", lore1.length, 1);
check("名称回退首个关键词", lore1[0]?.name, "影阁");
check("keys 数组合并为逗号分隔", lore1[0]?.keys, "影阁");
check("内容保留", lore1[0]?.content, "影阁是江湖第一杀手组织。");
check("默认启用", lore1[0]?.enabled, true);

// entry_name 优先 + 禁用标记 + 空内容过滤 + 旧式 key 单值
const richBook = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "测试角色",
    description: "d",
    personality: "",
    scenario: "",
    first_mes: "",
    mes_example: "",
    character_book: {
      entries: [
        { entry_name: "明面上的名字", name: "次级名", keys: ["甲", "乙"], content: "正文甲", enabled: true },
        { keys: ["丙"], content: "被禁用", enabled: false },
        { keys: ["丁"], content: "   ", enabled: true },
        { key: "旧式单键", content: "旧格式正文" },
        { keys: [], content: "无关键词=常驻词条" },
        { keys: ["宏"], content: "{{char}}与{{user}}在雨夜相遇。" },
      ],
    },
  },
};
const lore2 = extractLorebookEntries(CharacterCard.from_json(richBook));
check("空内容条目被过滤（6→5）", lore2.length, 5);
check("entry_name 优先于 name 与 keys", lore2[0]?.name, "明面上的名字");
check("多关键词合并", lore2[0]?.keys, "甲, 乙");
check("enabled=false 保留为禁用", lore2[1]?.enabled, false);
check("旧式 key 单值兼容", lore2[2]?.keys, "旧式单键");
check("无关键词条目 keys 为空（常驻）", lore2[3]?.keys, "");
check(
  "导入时 {{char}}/{{user}} 宏按来源卡名解析",
  lore2[4]?.content,
  "测试角色与主角在雨夜相遇。",
);

// 6. parseCharacterBytes 完整链路：JSON 字节 → { character, loreEntries }
console.log("--- parseCharacterBytes ---");
const parsed = await parseCharacterBytes(
  new TextEncoder().encode(JSON.stringify(v2Card)),
  "linwan.json",
  "application/json",
);
check("返回 character 主体", parsed.character.name, "林晚");
check("返回 loreEntries", parsed.character !== undefined && parsed.loreEntries.length, 1);
check("词条不含 id（由 store 生成）", "id" in (parsed.loreEntries[0] ?? { id: 0 }), false);

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
