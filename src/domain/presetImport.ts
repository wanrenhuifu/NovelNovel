import type { Preset } from "./types";

/**
 * 解析 SillyTavern 风格的预设 JSON 文件。
 *
 * 支持四种裸预设（按字段特征检测）与 ST-formatting 总信封：
 * - sysprompt：{ name, content, post_history } → 自定义系统提示词
 * - context：{ name, story_string, ... } → 设定区块模板
 * - instruct：{ name, input_sequence, output_sequence, ... } → 对话格式，
 *   由 API 消息结构承担，此处仅存档，不参与提示词组装
 * - reasoning：{ name, prefix, suffix } → 思考格式，小说场景不适用，拒绝导入
 * 信封：{ instruct?, context?, sysprompt?, reasoning?, preset?, srw? }，
 * 优先取 context/sysprompt 组装为一个预设。
 */

interface ParsedPreset {
  preset: Omit<Preset, "id" | "createdAt">;
  /** 解析过程中被忽略部分的用户提示 */
  note?: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 裸预设检测：instruct 必须有 input_sequence + output_sequence */
function isInstruct(o: Record<string, unknown>): boolean {
  return "input_sequence" in o && "output_sequence" in o;
}

/** context 模板检测：story_string 是字符串（空串也算认得出，由调用方报「空操作」） */
function isContext(o: Record<string, unknown>): boolean {
  return typeof o.story_string === "string";
}

/** sysprompt 检测：content 是字符串且非 instruct（排除误判） */
function isSysprompt(o: Record<string, unknown>): boolean {
  return typeof o.content === "string" && !isInstruct(o);
}

function parseInstruct(o: Record<string, unknown>): ParsedPreset {
  return {
    preset: {
      name: str(o.name).trim() || "未命名预设",
      kind: "instruct",
      systemPrompt: "",
      storyString: "",
      rawData: JSON.stringify(o),
    },
    note:
      "Instruct 预设控制的是对话轮次格式（由 API 的消息结构承担），不参与系统提示词组装，已存档备查。",
  };
}

/** 解析总信封：把 context.story_string 与 sysprompt.content 合并为一个预设 */
function parseEnvelope(o: Record<string, unknown>): ParsedPreset {
  const ctx = isRecord(o.context) ? o.context : null;
  const sys = isRecord(o.sysprompt) ? o.sysprompt : null;
  const storyString = ctx ? str(ctx.story_string) : "";
  const systemPrompt = sys ? str(sys.content) : "";
  // context.name 为空串时要回退到 sysprompt.name，否则「有名字的信封」会被叫成未命名
  const name = (str(ctx?.name).trim() || str(sys?.name).trim()) || "未命名预设";

  const notes: string[] = [];
  if (isRecord(o.instruct)) {
    notes.push("instruct（对话格式）部分已忽略");
  }
  if (isRecord(o.reasoning)) {
    notes.push("reasoning（思考格式）部分已忽略");
  }
  if (sys && sys.content !== undefined && typeof sys.content !== "string") {
    notes.push("sysprompt.content 不是字符串，已忽略");
  }
  if (ctx && ctx.story_string !== undefined && typeof ctx.story_string !== "string") {
    notes.push("context.story_string 不是字符串，已忽略");
  }

  return {
    preset: {
      name,
      kind: storyString ? "context" : "system",
      systemPrompt,
      storyString,
      rawData: JSON.stringify(o),
    },
    note: notes.length > 0 ? notes.join("；") + "。" : undefined,
  };
}

/**
 * 解析单个预设 JSON 文件。
 * 无法识别时抛出带中文说明的 Error。
 */
export function parsePresetFile(text: string): ParsedPreset {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("JSON 文件解析失败，内容不是合法的 JSON");
  }
  if (!isRecord(json)) {
    throw new Error("预设文件应是一个 JSON 对象");
  }

  // 总信封：含 context/sysprompt/instruct/reasoning 中至少一个子对象
  const envelopeKeys = ["context", "sysprompt", "instruct", "reasoning"] as const;
  if (envelopeKeys.some((k) => isRecord(json[k]))) {
    const parsed = parseEnvelope(json);
    if (!parsed.preset.systemPrompt && !parsed.preset.storyString) {
      throw new Error(
        "信封预设中未找到可用的 sysprompt 或 context 内容（仅含 instruct/reasoning，不适用于小说写作）",
      );
    }
    return parsed;
  }

  // 裸预设：按特征取用，**能合并就合并**。
  //
  // 原来是一条互斥的选择链（instruct > context > sysprompt），于是同时带 `content` 与
  // `story_string` 的文件只取一支：要么系统提示词静默丢失，要么 story_string 是空白时
  // 把本来可用的 `content` 一起否掉（同一个内容装进信封却能合并，换壳行为不一致）。
  if (isInstruct(json) && !isContext(json) && !isSysprompt(json)) return parseInstruct(json);

  const systemPrompt = str(json.content).trim();
  const storyString = str(json.story_string);
  if (systemPrompt !== "" || storyString.trim() !== "") {
    const kinds: string[] = [];
    if (systemPrompt !== "") kinds.push("content");
    if (storyString.trim() !== "") kinds.push("story_string");
    return {
      preset: {
        name: str(json.name).trim() || "未命名预设",
        kind: storyString.trim() !== "" ? "context" : "system",
        systemPrompt,
        storyString,
        rawData: JSON.stringify(json),
      },
      note: `按裸预设导入（${kinds.join(" + ")}）。`,
    };
  }

  // 走到这里说明一个可用字段都没有：给出与该文件形状相符的原因
  if (isContext(json)) {
    throw new Error(
      "这个预设的 story_string 是空的：导入它等于什么都不改（简报会退回内置默认提示词）。" +
        "请确认选对了文件。",
    );
  }
  if (isSysprompt(json)) {
    throw new Error(
      "这个预设的 content 是空的：导入它等于什么都不改（简报会退回内置默认提示词）。" +
        "请确认选对了文件。",
    );
  }
  if ("prefix" in json && "suffix" in json) {
    throw new Error("这是 reasoning（思考格式）预设，小说写作暂不适用");
  }

  throw new Error(
    "无法识别的预设格式：未找到 content（system 提示词）或 story_string（上下文模板）字段",
  );
}
