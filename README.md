# dsh-novelnovel · DeepSeek Harness 插件

用工作区里的**普通文件**写小说：agent 直接用 `novel_*` 工具建作品、写正文、导角色卡、维护世界观词条、
检索与导出；**续写由 harness 的模型承担**，插件负责把作者的设定（世界观 / 命中词条 / 参与角色 /
写作预设 / 前文摘录）组装成写作简报交给它。

本仓库就是插件包（`dsh.bundle.patch` → `cordis.patch.yml`，向 profile 插入一行 `id: novelnovel`）。
领域逻辑（角色卡解析、预设解析、提示词组装、词条关键词匹配、章节排序、全文搜索、PNG 卡读写、
字数统计）集中在 `src/domain/`，与 harness 侧的存储/注册代码分离。

## 安装

```bash
npm install
npm run build                    # 构建插件产物 lib/（不入库，改了 src/ 必须重建）

# 装进一个 dsh profile（不存在会自动初始化）
dsh plugin --profile novelnovel add .

# 验证：在真实 harness 服务上跑通全部工具（不调用模型）
npm run test:dsh                 # 默认 profile: novelnovel
DSH_PROFILE=web npm run test:dsh # 指定其它 profile
```

想装到已有的 `web` profile，把 profile 名换成 `web` 即可。
分发时用 `npm pack` 产出的 tarball 安装：插件会被复制进 profile 的 `node_modules`，不依赖本仓库工作树。

## 兼容性

已在两套环境验证（`npm run test:dsh` 35 项全过 + 真实 headless 会话）：

- `@deepseek-ai/dsh@0.1.5-rc.1`（npm 上的 `latest`，其子包解析为 `0.1.5-rc.2`）
- `@deepseek-ai/dsh@0.1.2-rc.1` CLI + `0.1.3-alpha.2` 子包（本机 source checkout 环境）

`package.json` 的 peerDependencies 用通配 `*`：插件运行时由 `src/harness.ts` 解析 harness 自己的包实例
（保证与运行中的 harness 同模块实例），不在依赖层面锁版本。`src/contract.ts` 镜像的 API 面已在
`0.1.3-alpha.2` 与 `0.1.5-rc.2` 之间逐项比对，无签名差异——升级 harness 后重跑一次
`npm run test:dsh` 即可确认。

## 用法

在装了插件的 profile 里开一个会话，直接用自然语言提写作需求即可；系统提示词会引导 agent 使用这些工具：

| 工具 | 作用 |
|---|---|
| `novel_project` | 作品的新建 / 列表 / 详情 / 改设定（简介、世界观、写作要求）/ 切换当前作品 / 删除 |
| `novel_chapter` | 章节列表、读取、新建、**追加（写正文的入口）**、覆写、改名、打标签、排序、检索、删除 |
| `novel_character` | SillyTavern 角色卡（PNG/JSON，V1/V2/V3）导入、查看、参与开关、再导出 PNG、移除 |
| `novel_lorebook` | 世界观词条维护（带关键词=命中才注入，无关键词=常驻注入） |
| `novel_preset` | 写作预设导入（SillyTavern JSON）/ 手写 / 编辑 / 激活 / 停用 |
| `novel_context` | **写作前必调**：组装本次的写作简报（系统提示词 + 指令块 + 注入清单 + 参与角色） |
| `novel_export` | 整书导出 Markdown / TXT，或全量备份 JSON |

另外自带：

- 技能 `novel-writing`（写作流程与连续性检查）、`novel-cards`（角色卡 / 预设的导入语义与宏规则），
  agent 按需加载，`/novel-writing` 之类的手势也能直接触发。
- 斜杠命令 `/novel`：直接打印当前作品状态（`/novel list` 列出全部，`/novel <作品>` 切换当前作品），
  不经过模型。
- 一小段系统提示词（order 4500），说明这个工作区里的小说该怎么写。

典型流程（agent 视角）：

```text
novel_context chapter=3 instruction="写林晚在城墙下遇到祭司"   → 拿到简报
（按简报写正文）
novel_chapter action=append chapter=3 text="…"                → 落到章节
novel_lorebook action=add name=祭司 keys=夜祷 content=…        → 记录新设定
```

`novel_context` 返回的系统提示词区块是设定与文风的权威来源：它就是给模型的 system prompt，
由 harness 自己的模型来遵守。

## 配置

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖，无需改插件包：

```yaml
- id: novelnovel
  name: dsh-novelnovel
  config:
    dataDir: .novelnovel          # 数据根目录（相对工作目录，默认 .novelnovel）
    defaultPrevChapterCount: 2    # 简报默认携带的前文章节数（默认 1）
    defaultPrevChapterChars: 2000 # 每个前文章节摘取的尾部字数（默认 1500）
    defaultRecentChars: 4000      # 当前章摘取的尾部字数（默认 3000）
```

非法配置（绝对路径、`..`、负数）在加载期直接抛错，不静默取默认值。

## 数据布局

```text
<工作目录>/.novelnovel/
  workspace.json                        当前作品
  projects/<projectId>/
    project.json                        标题 / 简介 / 世界观 / 写作要求
    lorebook.json                       世界观词条
    presets.json                        写作预设与激活项
    chapters/index.json                 章节元数据（标题、标签、顺序）
    chapters/<chapterId>.md             章节正文（Markdown，可直接用 read/write 工具编辑）
    characters/<id>.json               角色卡（rawData 无损保留）
    characters/<id>.<ext>              原始头像（扩展名与真实媒体类型一致）
    exports/                            导出结果
```

正文独立成文件是有意的：长篇小说用 `read`/`write` 工具直接改正文比走工具更顺手，
而 `novel_chapter action=list` 会重新读文件统计字数，所以绕过插件直接改文件也不会失同步。

## 设计说明

- **写入路径**：文本读写一律走 `ctx.fs`（受 harness 沙箱与权限策略约束、与 `write`/`edit`
  共用版本语义，并 `emit('fs/observed')` 让变更流与「先读后写」策略保持一致）。
  `ctx.fs` 没有删除与二进制写入能力，删文件与写 PNG 头像用 `node:fs` —— 这条路径**不受沙箱约束**，
  所以插件自己兜住：目标必须落在会话工作目录内，否则直接拒绝（`novel_character action=export
  out_path=<工作区外>` 会报错而不是写出去）。
- **损坏的数据文件**：`project.json` 读不出来的作品目录会被跳过并在 `novel_project action=list`
  里点名（不让一个坏目录把整个插件堵死）；`workspace.json` 损坏时同样不致命，但此时若有多部作品，
  解析「当前作品」会要求显式传 `project=` ——**宁可报错也不猜**，避免把正文写进错误的作品。
  例外是 `chapters/index.json`：它损坏时直接报错，因为静默当成空索引会让下一次建章覆盖掉整份目录。
  数据文件都是给人手改的，读 JSON 时容忍 BOM 与 CRLF。
- **harness 依赖不内联**：`@deepseek-ai/*` 是 peer，运行时由 harness 自己提供——服务按模块实例注册，
  内联第二份会重复注册。以 `link:` 方式安装时包位于工作区之外，Node 从包 realpath 找不到 harness
  的依赖闭包，所以 `src/harness.ts` 会依次尝试：普通 import → 从 harness 进程入口解析 →
  从 `$DSH_HOME/profiles` 与工作目录解析，并保证与运行中的 harness 是同一个模块实例。
- **API 契约副本**：`src/contract.ts` 是手写的最小类型契约（只含本插件用到的成员），
  依据 `@deepseek-ai/dsh@0.1.2-rc.1 / 0.1.3-alpha.2` 的真实签名整理。这样插件源码不依赖 harness
  的包解析路径就能通过 `tsc`；运行时行为由真实 harness 与端到端验证保证。
- **技能注册**：用 `ctx.skills.register` 运行时注册（rank 250），而不是去改 `skill-filesystem`
  的 `customSkillDirs`——后者是别的插件行的 config，覆盖它要重述 dsh-base 的整份配置（patch 是整行替换），
  极易随上游变化失效。副作用是项目级技能（rank 100/200）仍可覆盖同名插件技能。
- **破坏性操作**：删除作品 / 章节 / 角色卡都需要 `confirm=true`，插件会拒绝未确认的调用，
  提示先与用户确认。

## 开发

```bash
npm run build       # esbuild 打包到 lib/
npm run typecheck   # tsc -p .（严格模式，零错误）
npm test            # 4 个纯逻辑单测（卡解析 / 预设+提示词 / 检索 / 排序）
npm run test:dsh    # 端到端验证（需要已安装的 profile）
```

`npm run test:dsh` 会拉起真实 harness 服务（SystemPrompt + ToolRuntime + LocalFileSystem +
SkillRegistry + observation policy）并驱动全部工具：作品/章节/词条/角色卡（含 PNG 双写回读）/预设/
简报组装/关键词注入命中与未命中/检索/导出/技能注册/命令处理器/配置校验/工作区边界与损坏文件容错/
观察记录归属/卸载清理/系统提示词段，共 35 项检查，不调用模型。`npm test` 是它的快速补充：4 个纯逻辑单测直接
测 `src/domain/` 里的解析与组装函数。

`tests/perf-probe.mjs` 是性能探针（在 profile 目录里跑）：铺 3 部 × 200 章，
打印每个工具调用的耗时与 `ctx.fs` 调用次数。解析作品引用只读元数据、统计字数才读正文，
这条边界靠它守住——把正文读回解析路径会让一次 `action=append` 的调用数从 39 涨到 1839。
