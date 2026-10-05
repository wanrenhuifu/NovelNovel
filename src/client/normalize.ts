/**
 * 把宿主返回的数据归一化成面板敢用的形状。
 *
 * 为什么需要它：`lorebook.json` / `chapters/index.json` 是**给人手改的普通文件**
 * （README 明说），而宿主的宽松读只判「JSON 能不能解析」，不判形状。
 * 少写一个 `keys` 或 `tags`，面板里的一次 `.split` 就会抛 TypeError——
 * 首方的错误边界会接住，但 `main` 是独占条目，用户看到的是**一片空白**
 * 加控制台一行 `slot entry crashed in 'main'`，没有任何可读的错误信息。
 *
 * 纯函数、不碰 DOM，所以能直接用 node 测。
 */
import type { ChapterSummary, LoreEntrySummary, ProjectDetail } from "./api";

/** 落盘 JSON 里实际可能是任何东西 */
type Loose = Record<string, unknown>;

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asArray(value: unknown): Loose[] {
  return Array.isArray(value) ? value.filter((v): v is Loose => typeof v === "object" && v !== null) : [];
}

export function normalizeChapters(value: unknown): ChapterSummary[] {
  return asArray(value).map((raw) => ({
    id: asString(raw.id),
    title: asString(raw.title, "（无标题）"),
    tags: asStringArray(raw.tags),
    words: asNumber(raw.words),
    updatedAt: asNumber(raw.updatedAt),
  }));
}

export function normalizeLorebook(value: unknown): LoreEntrySummary[] {
  return asArray(value).map((raw) => ({
    id: asString(raw.id),
    name: asString(raw.name),
    keys: asString(raw.keys),
    enabled: asBoolean(raw.enabled, true),
  }));
}

/**
 * 整份作品详情归一化；作品本体缺字段时返回 null（面板会走空态而不是崩）。
 * 这里刻意只挑面板真正用到的字段，别的一律不带。
 */
export function normalizeDetail(value: unknown): ProjectDetail | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Loose;
  const project = raw.project;
  if (typeof project !== "object" || project === null) return null;
  const p = project as Loose;
  return {
    project: {
      id: asString(p.id),
      title: asString(p.title, "（无标题）"),
      synopsis: asString(p.synopsis),
      updatedAt: asNumber(p.updatedAt),
    },
    chapters: normalizeChapters(raw.chapters),
    characters: asArray(raw.characters).map((c) => ({
      id: asString(c.id),
      name: asString(c.name),
      active: asBoolean(c.active),
      specVersion: asString(c.specVersion),
      hasAvatar: asBoolean(c.hasAvatar),
      description: asString(c.description),
    })),
    lorebook: normalizeLorebook(raw.lorebook),
  };
}
