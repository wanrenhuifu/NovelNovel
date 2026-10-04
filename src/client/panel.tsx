/**
 * 写作面板主视图：只读。
 *
 * 刻意只读——编辑权第一期留给模型与用户的编辑器，
 * 面板先把「现在到底有什么」变可见（作品 / 章节 / 字数 / 角色 / 词条 / 正文）。
 */
import type { ReactNode } from "react";
import { Button, IconFolderRegular, Tag } from "@deepseek-ai/dsh-client-ui-primitives";
import { usePanel } from "./state";

export function NovelPanel(): ReactNode {
  const { state, actions } = usePanel();
  const { detail, chapter, projects, activeId } = state;
  const active = projects.find((p) => p.id === activeId) ?? null;

  return (
    <div className="nnv-root">
      <div className="nnv-header">
        <IconFolderRegular size={15} />
        <span className="nnv-title">{active?.title ?? "NovelNovel"}</span>
        {active ? (
          <span className="nnv-muted nnv-small">
            {String(active.chapters)} 章 · {formatWords(active.words)}
          </span>
        ) : null}
        <span className="nnv-spacer" />
        {projects.length > 1 ? (
          <ProjectSwitcher
            projects={projects}
            activeId={state.activeId}
            onSelect={actions.selectProject}
          />
        ) : null}
        <Button size="small" onClick={actions.refresh}>
          刷新
        </Button>
      </div>

      {state.error !== null ? <div className="nnv-error">{state.error}</div> : null}

      {state.loading && detail === null && state.error === null ? (
        <div className="nnv-empty">正在读取作品…</div>
      ) : detail === null ? (
        <div className="nnv-empty">
          <span>这个工作区里还没有作品。</span>
          <span className="nnv-small">
            让模型用 novel_project action=create 建一本，或说「写一本小说开始」。
          </span>
        </div>
      ) : (
        <div className="nnv-columns">
          <ChapterList detail={detail} activeId={chapter?.id ?? null} onSelect={actions.selectChapter} />
          <div className="nnv-body">
            <ChapterView chapter={chapter} loading={state.chapterLoading} detail={detail} />
          </div>
        </div>
      )}
    </div>
  );
}

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
  detail,
  activeId,
  onSelect,
}: {
  detail: { chapters: { id: string; title: string; words: number }[] };
  activeId: string | null;
  onSelect: (id: string) => void;
}): ReactNode {
  return (
    <div className="nnv-list">
      {detail.chapters.map((c) => (
        <button
          key={c.id}
          type="button"
          className="nnv-row"
          data-selected={c.id === activeId}
          onClick={() => {
            onSelect(c.id);
          }}
        >
          <span className="nnv-row-title">{c.title}</span>
          <span className="nnv-muted nnv-small">{formatWords(c.words)}</span>
        </button>
      ))}
    </div>
  );
}

function ChapterView({
  chapter,
  loading,
  detail,
}: {
  chapter: { id: string; title: string; content: string; words: number } | null;
  loading: boolean;
  detail: {
    characters: { id: string; name: string; active: boolean }[];
    lorebook: { id: string; name: string; keys: string; enabled: boolean }[];
  };
}): ReactNode {
  if (loading) return <div className="nnv-empty">正在读取章节…</div>;
  if (chapter === null) return <div className="nnv-empty">这本还没有章节。</div>;

  const participating = detail.characters.filter((c) => c.active);
  return (
    <div className="nnv-content">
      <h1>{chapter.title}</h1>
      <div className="nnv-tags">
        <Tag>{formatWords(chapter.words)}</Tag>
        <Tag>
          {String(participating.length)}/{String(detail.characters.length)} 角色参与
        </Tag>
        <Tag>{String(detail.lorebook.length)} 词条</Tag>
      </div>
      {participating.length > 0 ? (
        <p className="nnv-muted nnv-small">
          参与写作：{participating.map((c) => c.name).join("、")}
        </p>
      ) : null}
      <hr />
      {renderProse(chapter.content)}
    </div>
  );
}

/** 极简 markdown：只认标题、引用与空行分段——正文本来就是散文，不需要完整渲染器 */
function renderProse(content: string): ReactNode[] {
  const blocks = content.split(/\n{2,}/);
  return blocks.map((block, index) => {
    const text = block.trim();
    if (text === "") return null;
    if (text.startsWith("### ")) return <h2 key={index}>{text.slice(4)}</h2>;
    if (text.startsWith("## ")) return <h2 key={index}>{text.slice(3)}</h2>;
    if (text.startsWith("# ")) return <h1 key={index}>{text.slice(2)}</h1>;
    if (text.startsWith("> ")) {
      return (
        <p key={index} className="nnv-muted">
          {text.replace(/^> ?/gm, "")}
        </p>
      );
    }
    return <p key={index}>{text}</p>;
  });
}

function formatWords(words: number): string {
  if (words >= 10000) return `${(words / 10000).toFixed(1)} 万字`;
  return `${String(words)} 字`;
}
