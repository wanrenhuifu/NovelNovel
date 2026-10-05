/**
 * 写作面板主视图：只读。
 *
 * 取向：**像在读一本书**——行宽、行距、段落缩进按中文小说排版调过；
 * 界面元素克制，但每个数字都真实（章节体量、参与角色、命中词条）。
 *
 * 只读是刻意的：写操作要与模型抢同一份稿子，得先设计冲突 UX 并复用 CAS 语义。
 */
import type { ReactNode } from "react";
import { Button, IconListPenOutlineRegular, Tag } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChapterSummary, ProjectDetail } from "./api";
import { usePanel } from "./state";
import { useChapterKeys } from "./useChapterKeys";

/** detail 为 null 时的占位：复用同一个数组，避免每次渲染都新建（会让 effect 反复重建） */
const NO_CHAPTERS: ChapterSummary[] = [];
/** 同上：类型不对时退回的常量空数组（保持引用稳定） */
const NO_CHARACTERS: ProjectDetail["characters"] = [];
const NO_LOREBOOK: ProjectDetail["lorebook"] = [];

export function NovelPanel(): ReactNode {
  const { state, actions } = usePanel();
  const { detail, chapter, projects, activeId, error, loading, chapterLoading, chapterId } = state;
  const active = projects.find((p) => p.id === activeId) ?? null;

  // 防御性兜底：`api.ts` 的类型只是对**未校验 JSON** 的断言，`state.ts` 的归一化是第一道防线，
  // 这里是第二道。渲染测试证明过：没有它时 `chapters: null` / `lorebook: null` / `characters: null`
  // 会让整块面板被首方错误边界接走（用户看到一片空白 + 控制台一行）。
  // 第二道防线：类型对就用**原引用**（`asArray` 会造新数组，而新数组会让键盘监听的 effect
  // 反复解绑重绑——这正是最初引入 NO_CHAPTERS 的原因），类型不对才退回空数组。
  const chapters = Array.isArray(detail?.chapters) ? detail.chapters : NO_CHAPTERS;
  const characters = Array.isArray(detail?.characters) ? detail.characters : NO_CHARACTERS;
  const lorebook = Array.isArray(detail?.lorebook) ? detail.lorebook : NO_LOREBOOK;
  const { rootRef } = useChapterKeys(chapters, chapterId, actions.selectChapter);

  return (
    <div className="nnv-root" ref={rootRef} tabIndex={-1}>
      <header className="nnv-header">
        <span className="nnv-brand">
          <IconListPenOutlineRegular size={15} />
          <span className="nnv-title">{active?.title ?? "NovelNovel"}</span>
        </span>
        {active !== null ? (
          <span className="nnv-stats">
            <span>{String(active.chapters)} 章</span>
            <span className="nnv-dot">·</span>
            <span>{formatWords(active.words)}</span>
            {detail !== null ? (
              <>
                <span className="nnv-dot">·</span>
                <span>{String(characters.filter((c) => c.active).length)} 角色</span>
                <span className="nnv-dot">·</span>
                <span>{String(lorebook.length)} 词条</span>
              </>
            ) : null}
          </span>
        ) : null}
        <span className="nnv-spacer" />
        {projects.length > 1 ? (
          <ProjectSwitcher projects={projects} activeId={activeId} onSelect={actions.selectProject} />
        ) : null}
        <Button size="sm" onClick={actions.refresh}>
          刷新
        </Button>
      </header>

      {error !== null ? <div className="nnv-error">{error}</div> : null}

      {/* 读不出来的作品必须点名：否则用户会以为"没有作品"而去新建，真正的问题是他手改坏了一个文件 */}
      {state.unreadable.length > 0 ? (
        <div className="nnv-error">
          有 {String(state.unreadable.length)} 个作品目录读不出来（已跳过）：
          {state.unreadable.map((u) => `\n· ${u.id} —— ${u.error}`).join("")}
        </div>
      ) : null}

      {loading && detail === null && error === null ? (
        <Skeleton />
      ) : detail === null ? (
        <EmptyWorkspace />
      ) : (
        <div className="nnv-columns">
          <ChapterList
            chapters={chapters}
            selectedId={chapterId}
            onSelect={actions.selectChapter}
          />
          <div className="nnv-body">
            <ChapterView
              chapters={chapters}
              characters={characters}
              lorebook={lorebook}
              chapter={chapter}
              loading={chapterLoading}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** 顶栏的项目切换：作品多于一本才出现 */
function ProjectSwitcher({
  projects,
  activeId,
  onSelect,
}: {
  projects: { id: string; title: string }[];
  activeId: string | null;
  onSelect: (id: string) => void;
}): ReactNode {
  return (
    <select
      value={activeId ?? ""}
      onChange={(event) => {
        onSelect((event.target as HTMLSelectElement).value);
      }}
    >
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.title}
        </option>
      ))}
    </select>
  );
}

function ChapterList({
  chapters,
  selectedId,
  onSelect,
}: {
  chapters: ChapterSummary[];
  /** 用户选中的章节 id（不是"已加载"的那个：切章期间高亮应当立刻跟随） */
  selectedId: string | null;
  onSelect: (id: string) => void;
}): ReactNode {
  // 体量条按最长章节归一化：不写死"多少字算长"
  const longest = chapters.reduce((max, c) => (c.words > max ? c.words : max), 0);

  return (
    <nav className="nnv-list">
      <div className="nnv-list-head">
        <span>章节</span>
        <span className="nnv-spacer" />
        <span>{String(chapters.length)}</span>
      </div>
      <div className="nnv-list-body">
        {chapters.map((c, index) => (
          <button
            key={c.id}
            type="button"
            className="nnv-row"
            data-selected={c.id === selectedId}
            title={asArray(c.tags).length > 0 ? asArray(c.tags).join(" · ") : undefined}
            onClick={() => {
              onSelect(c.id);
            }}
          >
            <span className="nnv-row-index">{String(index + 1).padStart(2, "0")}</span>
            <span className="nnv-row-main">
              <span className="nnv-row-title">{c.title}</span>
              <span className="nnv-row-meta">
                <span>{formatWords(c.words)}</span>
                {longest > 0 ? (
                  <span className="nnv-bar">
                    <span
                      className="nnv-bar-fill"
                      style={{ width: `${String(Math.max(6, Math.round((c.words / longest) * 100)))}%` }}
                    />
                  </span>
                ) : null}
              </span>
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}

/**
 * 正文区。props 收的是**已经兜底过的数组**（在 `NovelPanel` 里统一兜），
 * 所以这里可以放心直接 `.findIndex` / `.filter`——不必每处再写一遍类型检查。
 */
function ChapterView({
  chapters,
  characters,
  lorebook,
  chapter,
  loading,
}: {
  chapters: ProjectDetail["chapters"];
  characters: ProjectDetail["characters"];
  lorebook: ProjectDetail["lorebook"];
  chapter: { id: string; title: string; content: string; words: number } | null;
  loading: boolean;
}): ReactNode {
  if (loading) {
    return (
      <div className="nnv-read">
        <div className="nnv-prose">
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className="nnv-skel" style={{ width: `${String(60 + ((i * 13) % 39))}%` }} />
          ))}
        </div>
      </div>
    );
  }
  if (chapter === null) {
    return (
      <div className="nnv-center">
        <span className="nnv-center-title">这本还没有章节</span>
        <span className="nnv-hint">让模型用 novel_chapter action=append 写下第一章。</span>
      </div>
    );
  }

  const index = chapters.findIndex((c) => c.id === chapter.id);
  const current = chapters[index];
  const participating = characters.filter((c) => c.active);
  const matched = matchEntries(lorebook, chapter.content);

  return (
    <>
      <div className="nnv-body-head">
        <h1 className="nnv-body-title">{chapter.title}</h1>
        <div className="nnv-chips">
          {index >= 0 ? <Tag>第 {String(index + 1)} 章</Tag> : null}
          <Tag>{formatWords(chapter.words)}</Tag>
          {current !== undefined
            ? asStringArray(current.tags).map((t) => <Tag key={t}>{t}</Tag>)
            : null}
          {participating.length > 0 ? (
            <span className="nnv-chip" data-tone="brand">
              参与写作 {participating.map((c) => c.name).join("、")}
            </span>
          ) : null}
          {matched > 0 ? <span className="nnv-chip">命中 {String(matched)} 条词条</span> : null}
        </div>
      </div>
      <div className="nnv-read">
        <div className="nnv-prose nnv-fade" key={chapter.id}>
          {renderProse(chapter.content)}
        </div>
      </div>
    </>
  );
}

function EmptyWorkspace(): ReactNode {
  return (
    <div className="nnv-center">
      <span className="nnv-center-title">这个工作区里还没有作品</span>
      <span className="nnv-hint">
        让模型用 <code>novel_project action=create</code> 建一本，或者说一句「写一本小说开始」。
        <br />
        面板显示的是工作区里 <code>.novelnovel/</code> 的真实文件，与模型读写的是同一份。
      </span>
    </div>
  );
}

function Skeleton(): ReactNode {
  return (
    <div className="nnv-columns">
      <nav className="nnv-list">
        <div className="nnv-list-head">章节</div>
        <div className="nnv-list-body">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="nnv-skel" style={{ width: `${String(70 - i * 5)}%` }} />
          ))}
        </div>
      </nav>
      <div className="nnv-body">
        <div className="nnv-read">
          <div className="nnv-prose">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="nnv-skel" style={{ width: `${String(58 + ((i * 17) % 40))}%` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 极简 markdown：只认标题、引用、分隔符与空行分段——正文是散文，不需要完整渲染器 */
function renderProse(rawContent: string): ReactNode[] {
  // 走 asString：`api.ts` 的类型是对未校验 JSON 的断言，`content` 是数字时
  // 这里的 `.split` 会让整块面板被首方错误边界接走（渲染测试抓到过）
  const blocks = asString(rawContent).split(/\n{2,}/);
  const out: ReactNode[] = [];
  blocks.forEach((block, index) => {
    const text = block.trim();
    if (text === "") return;
    if (/^(---|\*\s*\*\s*\*|···)$/.test(text)) {
      out.push(
        <p key={index} className="nnv-break">
          ◆
        </p>,
      );
      return;
    }
    if (text.startsWith("### ") || text.startsWith("## ")) {
      out.push(<h2 key={index}>{text.replace(/^#{2,3}\s+/, "")}</h2>);
      return;
    }
    if (text.startsWith("# ")) {
      out.push(<h2 key={index}>{text.slice(2)}</h2>);
      return;
    }
    if (text.startsWith("> ")) {
      out.push(<blockquote key={index}>{text.replace(/^> ?/gm, "")}</blockquote>);
      return;
    }
    out.push(<p key={index}>{text}</p>);
  });
  return out;
}

/**
 * 估算本章会命中多少条词条：与 `domain/prompt.ts` 的 selectLoreEntries 同语义——
 * 无关键词的词条常驻注入，有关键词的按包含关系匹配。这里只用于显示一个数字，
 * 所以不做全半角归一化（真正的注入判定在宿主侧）。
 *
 * 字段走 `asString` 兜底：`lorebook.json` 是给人手改的，少写一个 `keys` 就抛 TypeError 的话，
 * 整块面板会被首方错误边界接住变成空白。
 */
function matchEntries(entries: ProjectDetail["lorebook"], content: string): number {
  const haystack = asString(content).toLowerCase();
  return entries.filter((entry) => {
    if (!entry.enabled) return false;
    const keys = asString(entry.keys)
      .split(/[,，]/)
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k !== "");
    if (keys.length === 0) return true;
    return keys.some((k) => haystack.includes(k));
  }).length;
}

/**
 * 兜底：落盘 JSON 是给人手改的，类型上非空、实际可能缺失或类型不对。
 *
 * 两条防线是有意的：`state.ts` 的归一化是第一道（覆盖正常取数路径），这里是第二道
 * （覆盖任何绕过归一化的路径，以及归一化本身漏掉的字段）。渲染测试证明过没有它的后果：
 * `chapters: null` / `lorebook: null` / `characters: null` 会让整块面板被首方错误边界接走。
 */
function asArray<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is T => typeof item === "object" && item !== null);
}

/** 字符串数组用这个（元素也要过滤，`tags: [1, null]` 不该进渲染） */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatWords(words: number): string {
  if (words >= 100000000) return `${(words / 100000000).toFixed(2)} 亿字`;
  if (words >= 10000) return `${(words / 10000).toFixed(1)} 万字`;
  return `${String(words)} 字`;
}
