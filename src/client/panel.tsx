/**
 * 写作面板主视图：读 + 写。
 *
 * 取向：**像在读一本书**——行宽、行距、段落缩进按中文小说排版调过；
 * 界面元素克制，但每个数字都真实（章节体量、参与角色、命中词条、自检结论）。
 *
 * 写操作的三条口径（宿主侧是同一套，见 `src/clientApi.ts`）：
 * - **不做乐观更新**：写完重取。改的是模型正在写的同一份稿子，屏幕上"对的一版"与磁盘不一致
 *   是这个面板最不该有的状态。
 * - **保存带基准**：把加载进来的那份正文（不是草稿）回传给宿主做比对，对不上就 409。
 *   冲突时**保留用户输入**，只提示"重新加载"——用户写的东西不能因为一次冲突就没了。
 * - **危险操作二次确认**：删章节 / 删角色卡都要在面板上再点一次"确认删除"。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, IconListPenOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChapterSummary, ProjectDetail, ReviewSummary } from "./api";
import { usePanel } from "./state";
import { useChapterKeys } from "./useChapterKeys";

/** detail 为 null 时的占位：复用同一个数组，避免每次渲染都新建（会让 effect 反复重建） */
const NO_CHAPTERS: ChapterSummary[] = [];
/** 同上：类型不对时退回的常量空数组（保持引用稳定） */
const NO_CHARACTERS: ProjectDetail["characters"] = [];
const NO_LOREBOOK: ProjectDetail["lorebook"] = [];

export function NovelPanel(): ReactNode {
  const { state, actions } = usePanel();
  const {
    detail,
    chapter,
    projects,
    activeId,
    error,
    notice,
    loading,
    chapterLoading,
    chapterId,
    busy,
  } = state;
  const active = projects.find((p) => p.id === activeId) ?? null;
  /** 正文编辑器是否打开（面板级状态：切章时自动退出） */
  const [editing, setEditing] = useState(false);

  // 防御性兜底：`api.ts` 的类型只是对**未校验 JSON** 的断言，`state.ts` 的归一化是第一道防线，
  // 这里是第二道。渲染测试证明过：没有它时 `chapters: null` / `lorebook: null` / `characters: null`
  // 会让整块面板被首方错误边界接走（用户看到一片空白 + 控制台一行）。
  // 第二道防线：类型对就用**原引用**（`asArray` 会造新数组，而新数组会让键盘监听的 effect
  // 反复解绑重绑——这正是最初引入 NO_CHAPTERS 的原因），类型不对才退回空数组。
  const chapters = Array.isArray(detail?.chapters) ? detail.chapters : NO_CHAPTERS;
  const characters = Array.isArray(detail?.characters) ? detail.characters : NO_CHARACTERS;
  const lorebook = Array.isArray(detail?.lorebook) ? detail.lorebook : NO_LOREBOOK;
  const { rootRef } = useChapterKeys(chapters, chapterId, actions.selectChapter);

  // 换章就退出编辑：否则草稿会挂在上一章的正文上，保存下去就是串台
  useEffect(() => {
    setEditing(false);
  }, [chapterId]);

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
        {detail !== null ? (
          <TargetWords
            target={detail.project.targetWords}
            words={active?.words ?? 0}
            busy={busy}
            onSet={actions.setTargetWords}
          />        ) : null}
        <span className="nnv-spacer" />
        {projects.length > 1 ? (
          <ProjectSwitcher projects={projects} activeId={activeId} onSelect={actions.selectProject} />
        ) : null}
        <Button size="sm" onClick={actions.refresh} disabled={busy}>
          刷新
        </Button>
      </header>

      {error !== null ? <div className="nnv-error">{error}</div> : null}
      {error === null && notice !== null ? <div className="nnv-notice">{notice}</div> : null}

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
          <div className="nnv-side">
            <ChapterList
              chapters={chapters}
              selectedId={chapterId}
              busy={busy}
              onSelect={actions.selectChapter}
              onCreate={actions.createChapter}
              onRename={actions.renameChapter}
              onDelete={actions.deleteChapter}
              onMove={actions.moveChapter}
            />
            <CharacterList
              characters={characters}
              busy={busy}
              onImport={actions.importCharacter}
              onToggle={actions.setCharacterActive}
              onDelete={actions.deleteCharacter}
            />
          </div>
          <div className="nnv-body">
            <ChapterView
              chapters={chapters}
              characters={characters}
              lorebook={lorebook}
              chapter={chapter}
              loading={chapterLoading}
              busy={busy}
              editing={editing}
              onEdit={() => {
                setEditing(true);
              }}
              onCancelEdit={() => {
                setEditing(false);
              }}
              onSave={(text) => {
                actions.saveChapter(text);
              }}
              onReload={() => {
                setEditing(false);
                actions.refresh();
              }}
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

/**
 * 全书目标字数（顶栏右侧）：显示"已写 / 目标（百分比）"，点一下就能改。
 *
 * 它**不改模型怎么写**（那是 author_note 与每章 goal 的事），只回答"离目标还有多远"。
 */
function TargetWords({
  target: rawTarget,
  words,
  busy,
  onSet,
}: {
  target: number | null | undefined;
  words: number;
  busy: boolean;
  onSet: (words: number | null) => void;
}): ReactNode {
  // 归一化在这里再做一次：`detail` 走的是 `normalize.ts`，但渲染测试与任何绕过归一化的路径
  // 都可能递来 `undefined` / 字符串 / 负数——`undefined` 会被当成"有目标"而渲染出 `NaN%`
  const target =
    typeof rawTarget === "number" && Number.isFinite(rawTarget) && rawTarget > 0 ? rawTarget : null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(target === null ? "" : String(target));

  useEffect(() => {
    setDraft(target === null ? "" : String(target));
  }, [target]);

  if (!editing) {
    const percent = target === null ? null : Math.floor((words / target) * 100);
    return (
      <button
        type="button"
        className="nnv-target"
        title="设置全书目标字数（只用于看进度，不改变模型怎么写）"
        onClick={() => {
          setEditing(true);
        }}
      >
        {target === null
          ? "设目标字数"
          : // 刚开始写的时候「（0%）」只是噪音，百分比有意义了再显示
            percent !== null && percent > 0
            ? `目标 ${formatWords(target)}（${String(percent)}%）`
            : `目标 ${formatWords(target)}`}
      </button>
    );
  }

  const commit = (): void => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      onSet(null);
    } else {
      const value = Number(trimmed);
      if (!Number.isFinite(value) || value <= 0) return; // 非法输入就不提交，留在编辑态让用户改
      onSet(Math.round(value));
    }
    setEditing(false);
  };

  return (
    <span className="nnv-target-edit">
      <input
        className="nnv-input nnv-input-sm"
        type="number"
        min={0}
        value={draft}
        placeholder="全书多少字"
        autoFocus
        onChange={(event) => {
          setDraft((event.target as HTMLInputElement).value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setEditing(false);
        }}
      />
      <Button size="sm" onClick={commit} disabled={busy}>
        确定
      </Button>
      <Button
        size="sm"
        onClick={() => {
          onSet(null);
          setEditing(false);
        }}
        disabled={busy}
      >
        清除
      </Button>
      <Button
        size="sm"
        onClick={() => {
          setEditing(false);
        }}
      >
        取消
      </Button>
    </span>
  );
}

/** 左栏上半：章节列表（新建 / 改名 / 排序 / 删除都在行内） */
function ChapterList({
  chapters,
  selectedId,
  busy,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onMove,
}: {
  chapters: ChapterSummary[];
  /** 用户选中的章节 id（不是"已加载"的那个：切章期间高亮应当立刻跟随） */
  selectedId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: (title: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, direction: "up" | "down") => void;
}): ReactNode {
  // 体量条按最长章节归一化：不写死"多少字算长"
  const longest = chapters.reduce((max, c) => (c.words > max ? c.words : max), 0);
  /** 正在改名的章节 + 草稿；正在确认删除的章节 */
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  /** 新建章节的行内表单 */
  const [adding, setAdding] = useState<string | null>(null);

  return (
    <nav className="nnv-list">
      <div className="nnv-list-head">
        <span>章节</span>
        <span className="nnv-spacer" />
        <span className="nnv-count">{String(chapters.length)}</span>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setAdding("");
          }}
        >
          ＋ 新建
        </Button>
      </div>
      <div className="nnv-list-body">
        {adding !== null ? (
          <div className="nnv-form">
            <input
              className="nnv-input"
              value={adding}
              placeholder="章节标题，例如：第三章 祭坛"
              autoFocus
              onChange={(event) => {
                setAdding((event.target as HTMLInputElement).value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && adding.trim() !== "") {
                  onCreate(adding.trim());
                  setAdding(null);
                }
                if (event.key === "Escape") setAdding(null);
              }}
            />
            <div className="nnv-form-actions">
              <Button
                size="sm"
                disabled={busy || adding.trim() === ""}
                onClick={() => {
                  if (adding.trim() === "") return;
                  onCreate(adding.trim());
                  setAdding(null);
                }}
              >
                新建
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setAdding(null);
                }}
              >
                取消
              </Button>
            </div>
          </div>
        ) : null}

        {chapters.length === 0 && adding === null ? (
          <div className="nnv-hint nnv-list-empty">
            还没有章节。点「＋ 新建」写第一章，或让模型用 novel_chapter action=append 落笔。
          </div>
        ) : null}

        {chapters.map((c, index) => {
          const review = asReview(c.review);
          if (renaming !== null && renaming.id === c.id) {
            return (
              <div key={c.id} className="nnv-form">
                <input
                  className="nnv-input"
                  value={renaming.title}
                  autoFocus
                  onChange={(event) => {
                    setRenaming({ id: c.id, title: (event.target as HTMLInputElement).value });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && renaming.title.trim() !== "") {
                      onRename(c.id, renaming.title.trim());
                      setRenaming(null);
                    }
                    if (event.key === "Escape") setRenaming(null);
                  }}
                />
                <div className="nnv-form-actions">
                  <Button
                    size="sm"
                    disabled={busy || renaming.title.trim() === ""}
                    onClick={() => {
                      if (renaming.title.trim() === "") return;
                      onRename(c.id, renaming.title.trim());
                      setRenaming(null);
                    }}
                  >
                    改名
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      setRenaming(null);
                    }}
                  >
                    取消
                  </Button>
                </div>
              </div>
            );
          }
          return (
            <div
              key={c.id}
              className="nnv-row"
              data-selected={c.id === selectedId}
              role="button"
              tabIndex={-1}
              title={asArray<string>(c.tags).length > 0 ? asArray<string>(c.tags).join(" · ") : undefined}
              onClick={() => {
                setConfirming(null);
                onSelect(c.id);
              }}
            >
              <span className="nnv-row-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="nnv-row-main">
                <span className="nnv-row-title">{c.title}</span>
                <span className="nnv-row-meta">
                  <span className="nnv-words">{formatWords(c.words)}</span>
                  {longest > 0 ? (
                    <span className="nnv-bar" aria-hidden="true">
                      <span
                        className="nnv-bar-fill"
                        style={{ width: `${String(Math.max(8, Math.round((c.words / longest) * 100)))}%` }}
                      />
                    </span>
                  ) : null}
                  {/* 角标放第二行：第一行只留给标题。四个行内按钮 + 角标挤同一行时，
                      中文标题会被压成「第二章 …」（截图里看到过）。 */}
                  {review !== null ? (
                    <span className="nnv-badge" data-verdict={review.verdict}>
                      {reviewLabel(review)}
                    </span>
                  ) : null}
                </span>
              </span>
              {confirming === c.id ? (
                <span className="nnv-row-actions">
                  <button
                    type="button"
                    className="nnv-act"
                    data-danger="true"
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(c.id);
                      setConfirming(null);
                    }}
                  >
                    确认删除
                  </button>
                  <button
                    type="button"
                    className="nnv-act"
                    onClick={(event) => {
                      event.stopPropagation();
                      setConfirming(null);
                    }}
                  >
                    取消
                  </button>
                </span>
              ) : (
                <span className="nnv-row-actions">
                  <button
                    type="button"
                    className="nnv-act"
                    title="上移"
                    disabled={busy || index === 0}
                    onClick={(event) => {
                      event.stopPropagation();
                      onMove(c.id, "up");
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="nnv-act"
                    title="下移"
                    disabled={busy || index === chapters.length - 1}
                    onClick={(event) => {
                      event.stopPropagation();
                      onMove(c.id, "down");
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="nnv-act"
                    title="改名"
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      setRenaming({ id: c.id, title: c.title });
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="nnv-act"
                    title="删除这一章"
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      setConfirming(c.id);
                    }}
                  >
                    ✕
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

/** 左栏下半：角色卡（导入 / 参与开关 / 删除） */
function CharacterList({
  characters,
  busy,
  onImport,
  onToggle,
  onDelete,
}: {
  characters: ProjectDetail["characters"];
  busy: boolean;
  onImport: (file: File) => void;
  onToggle: (id: string, active: boolean) => void;
  onDelete: (id: string) => void;
}): ReactNode {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <section className="nnv-chars">
      <div className="nnv-list-head">
        <span>角色卡</span>
        <span className="nnv-spacer" />
        <span className="nnv-count">{String(characters.length)}</span>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            fileRef.current?.click();
          }}
        >
          导入
        </Button>
        <input
          ref={fileRef}
          className="nnv-file"
          type="file"
          accept=".png,.json,.webp,.jpg,.jpeg,image/png,image/webp,image/jpeg,application/json"
          onChange={(event) => {
            const input = event.target as HTMLInputElement;
            const file = input.files?.[0];
            // 清空 value：同一个文件选第二次也要能触发 change
            input.value = "";
            if (file !== undefined) onImport(file);
          }}
        />
      </div>
      <div className="nnv-list-body">
        {characters.length === 0 ? (
          <div className="nnv-hint nnv-list-empty">
            还没有角色卡。点「导入」选一张 SillyTavern 的 PNG / JSON 卡。
          </div>
        ) : null}
        {characters.map((c) => (
          <div
            key={c.id}
            className="nnv-row nnv-row-char"
            data-selected={false}
            data-active={c.active}
            title={c.active ? "参与写作（设定会进简报）" : "不参与写作（不会进简报）"}
          >
            {/* 首字头像：比"checkbox + 名字"像人。有真头像的卡先只标记，图片要另起一条路由给字节 */}
            <span className="nnv-avatar" aria-hidden="true">
              {Array.from(asString(c.name))[0] ?? "?"}
              {c.hasAvatar ? <span className="nnv-avatar-dot" /> : null}
            </span>
            <span className="nnv-row-main">
              <span className="nnv-row-title" title={asString(c.description)}>
                {c.name}
              </span>
              <span className="nnv-row-meta">
                <span>{asString(c.specVersion) || "?"}</span>
                {c.hasAvatar ? <span>· 有头像</span> : null}
              </span>
            </span>
            {/* 参与开关：小胶囊而不是 checkbox——四张卡并排时四个实心方块的视觉重量太大，
                而且"参与/不参与"自解释，不需要靠 tooltip */}
            <button
              type="button"
              className="nnv-toggle"
              data-on={c.active}
              disabled={busy}
              title={c.active ? "参与写作（设定会进简报）" : "不参与写作（不会进简报）"}
              onClick={() => {
                onToggle(c.id, !c.active);
              }}
            >
              {c.active ? "参与" : "不参与"}
            </button>
            {confirming === c.id ? (
              <span className="nnv-row-actions">
                <button
                  type="button"
                  className="nnv-act"
                  data-danger="true"
                  disabled={busy}
                  onClick={() => {
                    onDelete(c.id);
                    setConfirming(null);
                  }}
                >
                  确认删除
                </button>
                <button
                  type="button"
                  className="nnv-act"
                  onClick={() => {
                    setConfirming(null);
                  }}
                >
                  取消
                </button>
              </span>
            ) : (
              <span className="nnv-row-actions">
                <button
                  type="button"
                  className="nnv-act"
                  title="删除这张卡"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(c.id);
                  }}
                >
                  ✕
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
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
  busy,
  editing,
  onEdit,
  onCancelEdit,
  onSave,
  onReload,
}: {
  chapters: ProjectDetail["chapters"];
  characters: ProjectDetail["characters"];
  lorebook: ProjectDetail["lorebook"];
  chapter: {
    id: string;
    title: string;
    content: string;
    words: number;
    goal?: string;
    review?: ReviewSummary | null;
  } | null;
  loading: boolean;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (content: string) => void;
  onReload: () => void;
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
        <span className="nnv-hint">左栏点「＋ 新建」写第一章，或让模型用 novel_chapter action=append 落笔。</span>
      </div>
    );
  }

  const index = chapters.findIndex((c) => c.id === chapter.id);
  const current = chapters[index];
  const participating = characters.filter((c) => c.active);
  const matched = matchEntries(lorebook, chapter.content);
  const review = asReview(current?.review ?? chapter.review);
  const goal = asString(chapter.goal);

  return (
    <>
      <div className="nnv-body-head">
        <div className="nnv-page">
          <div className="nnv-body-headline">
            <h1 className="nnv-body-title">{chapter.title}</h1>
            <span className="nnv-spacer" />
            {editing ? (
              <>
                <Button size="sm" onClick={onReload} disabled={busy}>
                  重新加载
                </Button>
                <Button size="sm" onClick={onCancelEdit} disabled={busy}>
                  退出编辑
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={onEdit}>
                编辑正文
              </Button>
            )}
          </div>
          <div className="nnv-chips">
            {index >= 0 ? <span className="nnv-chip">第 {String(index + 1)} 章</span> : null}
            <span className="nnv-chip">{formatWords(chapter.words)}</span>
            {review !== null ? (
              <span className="nnv-chip" data-tone={review.verdict === "pass" ? "brand" : "warn"}>
                {reviewLabel(review)}
              </span>
            ) : null}
            {current !== undefined
              ? asArray<string>(current.tags).map((t) => (
                  <span className="nnv-chip" key={t}>
                    {t}
                  </span>
                ))
              : null}
            {participating.length > 0 ? (
              <span className="nnv-chip" data-tone="brand">
                参与写作 {participating.map((c) => c.name).join("、")}
              </span>
            ) : null}
            {matched > 0 ? <span className="nnv-chip">命中 {String(matched)} 条词条</span> : null}
          </div>
          {goal !== "" ? <div className="nnv-goal">本章目标：{goal}</div> : null}
          {editing ? (
            <div className="nnv-hint nnv-edit-hint">
              编辑的是磁盘上那份 Markdown 原文。保存时会带上你打开时的版本：如果模型（或另一个窗口）
              在这期间写过这一章，保存会「失败」并提示你重新加载——不会静默盖掉它。
            </div>
          ) : null}
        </div>
      </div>
      {editing ? (
        <ChapterEditor chapter={chapter} busy={busy} onSave={onSave} />
      ) : (
        <div className="nnv-read">
          <div className="nnv-page nnv-prose nnv-fade" key={chapter.id}>
            {renderProse(chapter.content)}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * 正文编辑器：一个 textarea + 保存。
 *
 * 两件事必须做对：
 * - **草稿不能被脚下的重取冲掉**：保存后会重取（拿到新的字数），如果此时无条件用新正文覆盖
 *   草稿，用户的输入就没了。规则是"只有草稿仍等于旧底稿（= 没改过）时才跟着新正文走"。
 * - **基准是底稿不是草稿**：`onSave` 只传草稿，宿主侧要比对的那份由 `state.ts` 里的
 *   `loadedContentRef` 提供（"我看到的是什么"与"我要写成什么"是两回事）。
 */
function ChapterEditor({
  chapter,
  busy,
  onSave,
}: {
  chapter: { id: string; content: string };
  busy: boolean;
  onSave: (content: string) => void;
}): ReactNode {
  const [draft, setDraft] = useState(chapter.content);
  const baseRef = useRef(chapter.content);

  useEffect(() => {
    const previous = baseRef.current;
    if (previous === chapter.content) return;
    baseRef.current = chapter.content;
    setDraft((current) => (current === previous ? chapter.content : current));
  }, [chapter.content]);

  const dirty = draft !== chapter.content;

  return (
    <div className="nnv-edit">
      <div className="nnv-page nnv-edit-inner">
        <textarea
          className="nnv-textarea"
          value={draft}
          spellCheck={false}
          onChange={(event) => {
            setDraft((event.target as HTMLTextAreaElement).value);
          }}
        />
        <div className="nnv-edit-actions">
          <span className="nnv-hint">
            {dirty ? "有未保存的改动" : "与磁盘一致"}
            {busy ? " · 保存中…" : ""}
          </span>
          <span className="nnv-spacer" />
          <Button
            size="sm"
            disabled={busy || !dirty}
            onClick={() => {
              // 守卫写两遍（这里 + `disabled`）：`disabled` 是视觉与语义，但组件库换实现、
              // 或测试里的 shim 丢掉这个属性时，一次"没改动也保存"的写入仍然会白白改写文件
              if (busy || !dirty) return;
              onSave(draft);
            }}
          >
            保存
          </Button>
        </div>
      </div>
    </div>
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

/** 自检结论的中文说明（枚举之外的值当"没有结论"） */
function asReview(value: unknown): ReviewSummary | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as { verdict?: unknown; attempts?: unknown };
  const verdict = raw.verdict;
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "inconclusive") return null;
  return { verdict, attempts: typeof raw.attempts === "number" ? raw.attempts : 0 };
}

function reviewLabel(review: ReviewSummary): string {
  if (review.verdict === "pass") return "自检通过";
  if (review.verdict === "fail") return `自检未过${review.attempts > 1 ? ` ×${String(review.attempts)}` : ""}`;
  return "自检未判定";
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

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatWords(words: number): string {
  if (words >= 100000000) return `${(words / 100000000).toFixed(2)} 亿字`;
  if (words >= 10000) return `${(words / 10000).toFixed(1)} 万字`;
  return `${String(words)} 字`;
}
