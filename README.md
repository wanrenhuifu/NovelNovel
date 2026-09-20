# dsh-novelnovel · DeepSeek Harness 插件

用工作区里的**普通文件**写小说：agent 直接用 `novel_*` 工具建作品、写正文、导角色卡、维护世界观词条、
检索与导出，**续写由 harness 的模型承担**，插件负责把作者的设定（世界观 / 命中词条 / 参与角色 /
写作预设 / 前文摘录）组装成写作简报交给它；方法层面的东西（文风、对话、节奏、结构）由自带的技能承载，
也可以导入你自己的。

本仓库就是插件包（`dsh.bundle.patch` → `cordis.patch.yml`，向 profile 插入一行 `id: novelnovel`）。
领域逻辑（角色卡解析、预设解析、技能包解析、提示词组装、词条关键词匹配、章节排序、全文搜索、
PNG 卡读写、字数统计）集中在 `src/domain/`，与 harness 侧的存储/注册代码分离。

## 安装

前置：`dsh` CLI 与 `pnpm` 都在 PATH 上——`dsh plugin` 是把参数转发给 profile 目录里的 pnpm。

### 装来用（tarball，不依赖工作树）

```bash
git clone https://github.com/wanrenhuifu/NovelNovel.git && cd NovelNovel
npm install
npm pack                                  # prepack 会自动构建出 lib/
dsh plugin --profile web add ./dsh-novelnovel-0.1.0.tgz
dsh web
```

### 装来改（源码 link）

```bash
npm install
npm run build
dsh plugin --profile web add .            # 装成 link，指向这个工作树
```

改完 `src/` 之后要 `npm run build` 再**重开 dsh 会话**——profile 加载的是构建产物，不是源码。

### npm

还没发布到 npm。发布之后会是 `dsh plugin --profile web add dsh-novelnovel`，装的是预构建产物，
不需要任何构建授权。

### 装进哪个 profile

| profile | 用途 |
|---|---|
| `web` | 浏览器界面，交互式写作 |
| `headless` | 一次性任务：`dsh --profile headless "给《长夜将至》写第三章"` |

⚠️ 只有 `web` / `headless` / `sdk` / `sdk-minimal` / `acp` 这五个名字会从自带模板自动初始化。
**自己起别的名字只会得到 `dsh-base` 一个 bundle，而 base 只是内核**——没有 Host、没有 HTTP、
没有一次性 runner，装上也用不了。另外 `desktop` 这个名字被 CLI 保留，会直接拒绝 boot 与插件管理请求。

### 验证装上了

```bash
dsh --profile web --dump-config | grep -i novelnovel   # 应能看到 # == dsh-novelnovel 那一层
```

### 不支持从 git 直接安装

`dsh plugin add github:wanrenhuifu/NovelNovel` 装不起来：git 安装拉的是源码而不是构建产物，
本包没有 `prepare` 脚本，到手没有 `lib/`，加载会失败。请用上面的 tarball 路径。

### 从哪个目录启动

dsh 把**启动时所在的目录**当作工作区根：小说数据落在 `<那个目录>/.novelnovel/`，项目级技能落在
「最近的含 `.git` 的祖先目录」的 `.dsh/skills/`。所以先 `cd` 到你的小说目录再启动。

## 兼容性

已在两套环境验证（`npm run test:dsh` 40 项全过 + 真实 headless 会话）：

- `@deepseek-ai/dsh@0.1.5-rc.1`（npm 上的 `latest`，其子包解析为 `0.1.5-rc.2`）
- `@deepseek-ai/dsh@0.1.2-rc.1` CLI + `0.1.3-alpha.2` 子包（本机 source checkout 环境）

`package.json` 的 peerDependencies 用通配 `*`：插件运行时由 `src/harness.ts` 解析 harness 自己的包实例
（保证与运行中的 harness 同模块实例），不在依赖层面锁版本。`src/contract.ts` 镜像的 API 面已在
`0.1.3-alpha.2` 与 `0.1.5-rc.2` 之间逐项比对，无签名差异——升级 harness 后重跑一次
`npm run test:dsh` 即可确认。

这一点与生态里多数插件的做法不同（它们写 `>=` 或 caret 区间，代价是 harness 一升级就可能装不上），
是本仓库有意的取舍：harness 还处在 developer preview，锁区间只会把上游的破坏性变更变成安装期的报错，
而真正的兼容性由 `contract.ts` 的逐项比对和端到端验证保证。

## 用法

在装了插件的 profile 里开一个会话，直接用自然语言提写作需求即可；系统提示词会引导 agent 使用这些工具：

| 工具 | 作用 |
|---|---|
| `novel_project` | 作品的新建 / 列表 / 详情 / 改设定（简介、世界观、写作要求）/ 切换当前作品 / 删除 |
| `novel_chapter` | 章节列表、读取、新建、**追加（写正文的入口）**、覆写、改名、打标签、排序、检索、删除 |
| `novel_character` | SillyTavern 角色卡（PNG/JSON，V1/V2/V3）导入、查看、参与开关、再导出 PNG、移除 |
| `novel_lorebook` | 世界观词条维护（带关键词=命中才注入，无关键词=常驻注入） |
| `novel_preset` | 写作预设导入（SillyTavern JSON）/ 手写 / 编辑 / 激活 / 停用 |
| `novel_skill` | 项目级写作方法技能：列出 / 导入技能包（JSON）/ 导出分享 / 删除 |
| `novel_context` | **写作前必调**：组装本次的写作简报（系统提示词 + 指令块 + 注入清单 + 参与角色） |
| `novel_export` | 整书导出 Markdown / TXT，或全量备份 JSON |

另外自带 6 个技能，agent 按需加载（`/novel-prose` 之类的手势也能直接触发）：

| 技能 | 管什么 |
|---|---|
| `novel-writing` | 工具流程与连续性检查（先读简报、写正文、落盘、记设定） |
| `novel-cards` | 角色卡 / 预设的导入语义与宏规则 |
| `novel-prose` | 文风与叙述：视角一致性、叙事距离、句式节奏、去 AI 味 |
| `novel-dialogue` | 对话：潜台词、说话人辨识度、标签与动作拍、避免翻译腔 |
| `novel-scene` | 场景与节奏：场景 vs 概述、目标/阻碍/转折、章末钩子 |
| `novel-outline` | 结构与大纲、伏笔回收、通读一致性审计、中文网文套路 |

技能是**按需加载**的：模型平时只看得到每个技能的名字和一句描述，判断相关了才把正文拉进上下文。
所以这些方法平时不占上下文，也不会和你的写作预设打架——需要的时候它们才出现。

## 装你自己的写作方法

项目根的 `.dsh/skills/` 是 harness 自己的技能目录：它会被自动扫描、改动实时生效，而且**优先级高于
插件内置技能**（项目 rank 100/200，插件 rank 250）——所以同名时生效的是你那一份。

你可以直接往里放 `SKILL.md`，也可以让 agent 用 `novel_skill` 导入一个技能包：

```jsonc
// 技能包：可以含多个技能；也可以去掉 skills，把单个技能写在顶层
{
  "name": "我的爽文写法",        // 包名，给人看的，可含中文
  "author": "you",
  "version": "1.0.0",
  "skills": [
    {
      "name": "fast-payoff",    // 必须是 kebab-case，其它形式 harness 会拒绝
      "description": "Move the payoff closer to the setup.",  // 模型唯一能看到的字段，写成路由判据
      "whenToUse": "爽点 / 铺垫太长 / 节奏太慢",                // 可选，补充触发场景（中文触发词要留在这里）
      "content": "# 爽点前移\n\n正文，Markdown。"              // 技能正文
    }
  ]
}
```

```text
novel_skill action=import path=my-pack.json          落到 .dsh/skills/，harness 实时收录
novel_skill action=list                              现在装了哪些、哪些覆盖了内置技能
novel_skill action=export name=fast-payoff           导出成包，可以分享给别人
novel_skill action=remove name=fast-payoff confirm=true
```

导入的技能和你手写的技能走**完全相同的加载路径**——插件只负责摆文件，加载是 harness 自己的事，
所以插件里没有第二套技能机制。`novel_skill` 也只删自己导入的（按 `.novelnovel-skill.json` 标记识别），
手写的技能它一律不覆盖、不删除。

需要知道的一件事：harness 取的项目根是「最近的含 `.git` 的祖先目录，没有就用当前工作目录」。如果会话
开在仓库的子目录里，技能该放的地方就在工作区之外了——这时 `novel_skill` 会**拒绝并说明原因**，
而不是写到一个不会被扫描的位置。

斜杠命令 `/novel`：直接打印当前作品状态（`/novel list` 列出全部，`/novel <作品>` 切换当前作品），
不经过模型。

一小段系统提示词（order 4500），说明这个工作区里的小说该怎么写。

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
  skillpacks/                           novel_skill 导出的技能包

<项目根>/.dsh/skills/                   项目级技能（harness 自己扫描，含 novel_skill 导入的）
  <技能名>/SKILL.md
  <技能名>/.novelnovel-skill.json       导入标记（手写的技能没有它）
```

正文独立成文件是有意的：长篇小说用 `read`/`write` 工具直接改正文比走工具更顺手，
而 `novel_chapter action=list` 会重新读文件统计字数，所以绕过插件直接改文件也不会失同步。

技能不放在数据目录里，因为它是整个工作区的写作方法，不属于某部作品——见「装你自己的写作方法」。

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
  极易随上游变化失效。副作用是项目级技能（rank 100/200）天然覆盖同名插件技能，正好成了
  「装你自己的写作方法」那条路径。
- **技能写在 `<dataDir>` 之外**：技能属于整个工作区，不属于某部作品，所以落在项目根的 `.dsh/skills/`
  （harness 自己的目录）。项目根按 harness 的口径取「最近的含 `.git` 的祖先目录，没有则用工作目录」；
  会话开在仓库子目录里时项目根在工作区之外，此时 `novel_skill` **拒绝并说明原因**，而不是写到一个
  不会被扫描的地方——「工具报成功、技能却不生效」是最难查的一类问题。这是插件唯一往数据目录之外
  写文件的地方，范围由 `ctx.fs.contains` 收紧；导入的技能文件与手写技能走同一条 harness 加载路径，
  插件只摆文件，不维护第二套机制。
- **破坏性操作**：删除作品 / 章节 / 角色卡都需要 `confirm=true`，插件会拒绝未确认的调用，
  提示先与用户确认。

## 开发

```bash
npm run build       # esbuild 打包到 lib/
npm run typecheck   # tsc -p .（严格模式，零错误）
npm test            # 5 个纯逻辑单测（卡解析 / 预设+提示词 / 检索 / 排序 / 技能包）
npm run test:dsh    # 端到端验证（需要已装好插件的 profile，默认 novelnovel，可用 DSH_PROFILE 覆盖）
```

`npm run test:dsh` 会拉起真实 harness 服务（SystemPrompt + ToolRuntime + LocalFileSystem +
SkillRegistry + observation policy）并驱动全部工具：作品/章节/词条/角色卡（含 PNG 双写回读）/预设/
简报组装/关键词注入命中与未命中/检索/导出/技能注册（按 `skills/` 里的 SKILL.md 逐个核对）/项目级技能
（技能包导入→列出→导出→再导入→删除，含手写技能不被覆盖、校验失败不写一半）/命令处理器/配置校验/
工作区边界与损坏文件容错/观察记录归属/卸载清理/系统提示词段，共 40 项检查，不调用模型。
`npm test` 是它的快速补充：5 个纯逻辑单测直接测 `src/domain/` 里的解析与组装函数。

`tests/perf-probe.mjs` 是性能探针（在 profile 目录里跑）：铺 3 部 × 200 章，
打印每个工具调用的耗时与 `ctx.fs` 调用次数。解析作品引用只读元数据、统计字数才读正文，
这条边界靠它守住——把正文读回解析路径会让一次 `action=append` 的调用数从 39 涨到 1839。
