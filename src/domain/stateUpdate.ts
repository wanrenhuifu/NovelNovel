/**
 * 状态层：MVU 兼容的变量树 + `<UpdateVariable>` 输出解析（纯逻辑，不碰文件系统）。
 *
 * 协议来自真实卡《道渊》的 `[mvu_update]变量输出格式`（3,768 字）：
 *
 * ```
 * <UpdateVariable>
 * <Analysis>逐类写"变了什么 / 没变"</Analysis>
 * <JSONPatch>
 * [ {"op":"replace","path":"/主角/境界","value":"金丹中期（DC:52）"},
 *   {"op":"delta","path":"/世界/遭遇冷却","value":-1} ]
 * </JSONPatch>
 * </UpdateVariable>
 * ```
 *
 * 口径（照卡里的规则，不自己发明）：
 * - 是 **JSON Patch** 的变体：支持 `replace / delta / insert / remove / move`；
 * - `path` **必须以 `/` 开头**（卡里写"否则 fatal"），按 JSON Pointer 转义（`~1` → `/`，`~0` → `~`）；
 * - 数组可用 `-` 表示"追加到末尾"；
 * - `delta` 只作用于数字，且路径必须已存在；
 * - `_` 开头的字段是只读（模型写错了要拒绝并说明）。
 *
 * 我们比卡宽一点、并把这个宽容**写在这里**：`replace` 命中不存在的路径时**创建**它（模型常会直接
 * 写新键，比如给 `人物` 加一个 NPC），日志里记为 created。拒绝的 op 一律进 `rejected`，绝不静默忽略。
 */

/** 一棵变量树。值只能是标量、对象或数组（与 JSON 同构） */
export type StateValue = string | number | boolean | null | StateValue[] | { [key: string]: StateValue };
export type StateTree = { [key: string]: StateValue };

/** 一条 patch 操作 */
export interface PatchOp {
  op: string;
  path: string;
  /** delta 的增量、replace/insert 的值、move 的起点 */
  value?: StateValue;
  from?: string;
}

export interface PatchOutcome {
  tree: StateTree;
  applied: { op: string; path: string; created?: boolean }[];
  rejected: { op: string; path: string; reason: string }[];
}

/* ─────────────────────────── 迷你 YAML（初值树） ─────────────────────────── */

/**
 * 解析 `[initvar] 初始` 那种形状（缩进 2 空格的嵌套映射）。
 * **只支持它实际用到的子集**：`key:`、`key: 标量`、`{}`、`[]`、`[a, b]`、数字/布尔/null、引号字符串。
 * 遇到看不懂的结构就报错——静默半解析出来的树比没有更糟。
 */
export function parseInitvar(text: string): StateTree {
  const root: StateTree = {};
  /** 当前路径上的容器栈：indent → 容器 */
  const stack: { indent: number; container: StateTree }[] = [{ indent: -1, container: root }];
  const lines = text.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) continue;
    if (/^\s*-/.test(rawLine)) {
      throw new Error(`initvar 第 ${String(index + 1)} 行：不支持列表项（只认 key: value 结构）`);
    }
    const match = /^(\s*)([^:]+):(.*)$/.exec(rawLine);
    if (match === null) {
      throw new Error(`initvar 第 ${String(index + 1)} 行看不懂（期望 key: value）：${rawLine.trim().slice(0, 40)}`);
    }
    const indent = match[1].length;
    const key = match[2].trim();
    const rest = match[3].trim();
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].container;

    if (rest === "") {
      const child: StateTree = {};
      parent[key] = child;
      stack.push({ indent, container: child });
      continue;
    }
    parent[key] = parseScalar(rest);
  }
  return root;
}

function parseScalar(text: string): StateValue {
  if (text === "{}") return {};
  if (text === "[]") return [];
  if (text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(/[,，]/).map((part) => parseScalar(part.trim()));
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) return text.slice(1, -1);
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1);
  const asNumber = Number(text);
  if (text !== "" && Number.isFinite(asNumber)) return asNumber;
  return text;
}

/* ─────────────────────────── `<UpdateVariable>` 解析 ─────────────────────────── */

const BLOCK_RE = /<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/gi;

/**
 * 从模型写的正文里抠出 `<UpdateVariable>` 块，并返回**剥掉它们之后**的正文。
 * 大小写不敏感、允许出现多块（多块按出现顺序依次应用）。
 */
export function extractUpdateBlocks(text: string): { body: string; blocks: string[] } {
  const blocks: string[] = [];
  const body = text.replace(BLOCK_RE, (_whole, inner: string) => {
    blocks.push(inner);
    return "";
  });
  // 剥掉块之后常留下连续空行，收一下（但不动正文内部的排版）
  return { body: body.replace(/\n{3,}/g, "\n\n").trimEnd(), blocks };
}

/** 从一个块里取出 Analysis 与 patch 数组。坏形状给出可读原因，不抛异常。 */
export function parseUpdateBlock(block: string): {
  analysis: string;
  patch: PatchOp[];
  error?: string;
} {
  const analysisMatch = /<Analysis>([\s\S]*?)<\/Analysis>/i.exec(block);
  const analysis = analysisMatch === null ? "" : analysisMatch[1].trim();

  // patch 可能在 <JSONPatch> 里，也可能是块里唯一的一段 JSON
  const tagged = /<JSONPatch>([\s\S]*?)<\/JSONPatch>/i.exec(block);
  const candidate = (tagged === null ? block : tagged[1]).trim();
  const arrayStart = candidate.indexOf("[");
  if (arrayStart < 0) return { analysis, patch: [], error: "块里没有 patch 数组" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(arrayStart));
  } catch (error) {
    // 常见坏形状：JSON 后面还跟了别的文字 → 从第一个 `[` 到最后一个 `]` 再试一次
    const arrayEnd = candidate.lastIndexOf("]");
    if (arrayEnd <= arrayStart) return { analysis, patch: [], error: `patch 不是合法 JSON：${(error as Error).message}` };
    try {
      parsed = JSON.parse(candidate.slice(arrayStart, arrayEnd + 1));
    } catch {
      return { analysis, patch: [], error: `patch 不是合法 JSON：${(error as Error).message}` };
    }
  }
  if (!Array.isArray(parsed)) return { analysis, patch: [], error: "patch 不是数组" };
  const patch: PatchOp[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    patch.push({
      op: typeof record.op === "string" ? record.op : "",
      path: typeof record.path === "string" ? record.path : "",
      ...(record.value === undefined ? {} : { value: record.value as StateValue }),
      ...(typeof record.from === "string" ? { from: record.from } : {}),
    });
  }
  return { analysis, patch };
}

/* ─────────────────────────── 应用 patch ─────────────────────────── */

function isPlainObject(value: unknown): value is Record<string, StateValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** JSON Pointer → 路径段；`~1` 还原成 `/`、`~0` 还原成 `~` */
function segments(path: string): string[] {
  return path
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function readAt(root: StateValue, parts: string[]): StateValue | undefined {
  let cursor: StateValue | undefined = root;
  for (const part of parts) {
    if (isPlainObject(cursor)) cursor = cursor[part];
    else if (Array.isArray(cursor)) {
      const index = Number(part);
      cursor = Number.isInteger(index) ? cursor[index] : undefined;
    } else return undefined;
  }
  return cursor;
}

/**
 * 写入；返回是否**新建**了键。数组下标越界时补 null 到目标位置（模型常直接写 /a/3）。
 */
function writeAt(root: StateValue, parts: string[], value: StateValue): { ok: boolean; created: boolean; reason?: string } {
  if (parts.length === 0) return { ok: false, created: false, reason: "路径为空" };
  const setIn = (node: StateValue, rest: string[]): { ok: boolean; created: boolean; reason?: string } => {
    const [head, ...tail] = rest;
    const last = tail.length === 0;
    if (isPlainObject(node)) {
      const existed = Object.prototype.hasOwnProperty.call(node, head);
      if (last) {
        node[head] = value;
        return { ok: true, created: !existed };
      }
      if (!isPlainObject(node[head]) && !Array.isArray(node[head])) {
        node[head] = {};
      }
      return setIn(node[head] as StateValue, tail);
    }
    if (Array.isArray(node)) {
      if (head === "-" && last) {
        node.push(value);
        return { ok: true, created: true };
      }
      const index = Number(head);
      if (!Number.isInteger(index) || index < 0) return { ok: false, created: false, reason: `数组下标不是数字：${head}` };
      while (node.length < index) node.push(null);
      if (last) {
        const existed = index < node.length;
        node[index] = value;
        return { ok: true, created: !existed };
      }
      if (!isPlainObject(node[index]) && !Array.isArray(node[index])) node[index] = {};
      return setIn(node[index] as StateValue, tail);
    }
    return { ok: false, created: false, reason: "父级不是容器" };
  };
  return setIn(root, parts);
}

function removeAt(root: StateValue, parts: string[]): { ok: boolean; reason?: string } {
  if (parts.length === 0) return { ok: false, reason: "路径为空" };
  const parent = readAt(root, parts.slice(0, -1));
  const key = parts[parts.length - 1];
  if (isPlainObject(parent)) {
    if (!Object.prototype.hasOwnProperty.call(parent, key)) return { ok: false, reason: `路径不存在：/${parts.join("/")}` };
    delete parent[key];
    return { ok: true };
  }
  if (Array.isArray(parent)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) return { ok: false, reason: `数组下标越界：${key}` };
    parent.splice(index, 1);
    return { ok: true };
  }
  return { ok: false, reason: "父级不是容器" };
}

/**
 * 应用一批 patch。**逐条独立**：一条失败不影响其余（并进 `rejected`），
 * 这样模型一次写错一条不会让整章的状态更新全部作废。
 */
export function applyPatch(tree: StateTree, ops: PatchOp[]): PatchOutcome {
  const next = clone(tree);
  const applied: PatchOutcome["applied"] = [];
  const rejected: PatchOutcome["rejected"] = [];

  for (const op of ops) {
    const fail = (reason: string): void => {
      rejected.push({ op: op.op, path: op.path, reason });
    };
    if (!op.path.startsWith("/")) {
      fail('path 必须以 "/" 开头');
      continue;
    }
    const parts = segments(op.path);
    if (parts.length === 0) {
      fail("path 指向根（不支持整体替换）");
      continue;
    }
    if (parts[0].startsWith("_")) {
      fail("_ 开头的字段是只读");
      continue;
    }

    if (op.op === "replace" || op.op === "insert") {
      const result = writeAt(next, parts, op.value === undefined ? null : op.value);
      if (result.ok) applied.push({ op: op.op, path: op.path, ...(result.created ? { created: true } : {}) });
      else fail(result.reason ?? "写入失败");
      continue;
    }
    if (op.op === "delta") {
      if (typeof op.value !== "number" || !Number.isFinite(op.value)) {
        fail("delta 的 value 必须是数字");
        continue;
      }
      const current = readAt(next, parts);
      if (typeof current !== "number") {
        fail(`delta 只作用于已有数字（当前是 ${current === undefined ? "不存在" : typeof current}）`);
        continue;
      }
      const result = writeAt(next, parts, current + op.value);
      if (result.ok) applied.push({ op: "delta", path: op.path });
      else fail(result.reason ?? "写入失败");
      continue;
    }
    if (op.op === "remove") {
      const result = removeAt(next, parts);
      if (result.ok) applied.push({ op: "remove", path: op.path });
      else fail(result.reason ?? "删除失败");
      continue;
    }
    if (op.op === "move") {
      const from = op.from ?? "";
      if (!from.startsWith("/")) {
        fail('move 的 from 必须以 "/" 开头');
        continue;
      }
      const movedValue = readAt(next, segments(from));
      if (movedValue === undefined) {
        fail(`move 的 from 不存在：${from}`);
        continue;
      }
      const removed = removeAt(next, segments(from));
      if (!removed.ok) {
        fail(removed.reason ?? "move 删除失败");
        continue;
      }
      const result = writeAt(next, parts, movedValue);
      if (result.ok) applied.push({ op: "move", path: op.path });
      else fail(result.reason ?? "move 写入失败");
      continue;
    }
    fail(`不认识的 op："${op.op}"`);
  }

  return { tree: next, applied, rejected };
}

/* ─────────────────────────── 渲染成提示词文本 ─────────────────────────── */

const renderValue = (value: StateValue): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.map(renderValue).join("、");
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    return keys.length === 0 ? "{}" : keys.map((key) => `${key}=${renderValue(value[key])}`).join("；");
  }
  return String(value);
};

/**
 * 把变量树渲染成**给人看也给药模型看**的缩进列表。
 * 截断口径：最多 `maxLines` 行、`maxChars` 字符——状态是每章都要进的，不能无限长。
 */
export function renderState(tree: StateTree, maxLines = 60, maxChars = 4000): string {
  const lines: string[] = [];
  const walk = (node: StateValue, prefix: string, depth: number): void => {
    if (lines.length >= maxLines) return;
    if (isPlainObject(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (lines.length >= maxLines) return;
        const label = prefix === "" ? key : `${prefix}.${key}`;
        if (isPlainObject(value) && Object.keys(value).length > 0 && depth < 2) walk(value, label, depth + 1);
        else lines.push(`${label}: ${renderValue(value)}`);
      }
      return;
    }
    lines.push(`${prefix}: ${renderValue(node)}`);
  };
  walk(tree, "", 0);
  let text = lines.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…（状态较长，其余已省略）`;
  return text;
}
