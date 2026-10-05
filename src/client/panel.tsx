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

export function NovelPanel(): ReactNode {
  const { state, actions } = usePanel();
  const { detail, chapter, projects, activeId, error, loading, chapterLoading } = state;
  const active = projects.find((p) => p.id === activeId) ?? null;

  useChapterKeys(detail?.chapters ?? [], actions.selectChapter);

  return (
    <div className="nnv-root">
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
                <span>{String(countActive(detail))} 角色</span>
                <span className="nnv-dot">·</span>
                <span>{String(detail.lorebook.length)} 词条</span>
              </>
            ) : null}
          </span>
        ) : null}
        <span className="nnv-spacer" />
        {projects.length > 1 ? (
          <ProjectSwitcher projects={projects} activeId={activeId} onSelect={actions.selectProject} />
        ) : null}
        <Button size="small" onClick={actions.refresh}>
          刷新
        </Button>
      </header>

      {error !== null ? <div className="nnv-error">{error}</div> : null}

      {loading && detail === null && error === null ? (
        <Skeleton />
      ) : detail === null ? (
        <EmptyWorkspace />
      ) : (
        <div className="nnv-columns">
          <ChapterList
            chapters={detail.chapters}
            activeId={chapter?.id ?? null}
            onSelect={actions.selectChapter}
          />
          <div className="nnv-body">
            <ChapterView detail={detail} chapter={chapter} loading={chapterLoading} />
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
  activeId,
  onSelect,
}: {
  chapters: ChapterSummary[];
  activeId: string | null;
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
            data-selected={c.id === activeId}
            data-chapter-id={c.id}
            title={c.tags.length > 0 ? c.tags.join(" · ") : undefined}
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

function ChapterView({
  detail,
  chapter,
  loading,
}: {
  detail: ProjectDetail;
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

  const index = detail.chapters.findIndex((c) => c.id === chapter.id);
  const current = detail.chapters[index];
  const participating = detail.characters.filter((c) => c.active);
  const matched = matchEntries(detail, chapter.content);

  return (
    <>
      <div className="nnv-body-head">
        <h1 className="nnv-body-title">{chapter.title}</h1>
        <div className="nnv-chips">
          {index >= 0 ? <Tag>第 {String(index + 1)} 章</Tag> : null}
          <Tag>{formatWords(chapter.words)}</Tag>
          {current !== undefined
            ? current.tags.map((t) => <Tag key={t}>{t}</Tag>)
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
function renderProse(content: string): ReactNode[] {
  const blocks = content.split(/\n{2,}/);
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

function countActive(detail: ProjectDetail): number {
  return detail.characters.filter((c) => c.active).length;
}

/**
 * 估算本章会命中多少条词条：与 `domain/prompt.ts` 的 selectLoreEntries 同语义——
 * 无关键词的词条常驻注入，有关键词的按包含关系匹配。这里只用于显示一个数字，
 * 所以不做全半角归一化（真正的注入判定在宿主侧）。
 */
function matchEntries(detail: ProjectDetail, content: string): number {
  const haystack = content.toLowerCase();
  return detail.lorebook.filter((entry) => {
    if (!entry.enabled) return false;
    const keys = entry.keys
      .split(/[,，]/)
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k !== "");
    if (keys.length === 0) return true;
    return keys.some((k) => haystack.includes(k));
  }).length;
}

function formatWords(words: number): string {
  if (words >= 100000000) return `${(words / 100000000).toFixed(2)} 亿字`;
  if (words >= 10000) return `${(words / 10000).toFixed(1)} 万字`;
  return `${String(words)} 字`;
}
