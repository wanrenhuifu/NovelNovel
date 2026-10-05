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

### 装进 DSH 桌面端

桌面端有自己的 profile，叫 `desktop`，由应用独占（`dsh --profile desktop` 启动会被拒），
但**插件管理是支持的**——桌面端自带的 CLI wrapper 就是以「允许管理 desktop」的方式跑起来的。
步骤：

```powershell
# 1) 完全退出 DeepSeek Harness Desktop（它持有 profile 的 package.json 锁）
# 2) 用桌面端自带的 CLI 装（路径按你的安装位置改；默认装在 D:\DSH）
& "D:\DSH\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add D:\novelnovel
# 3) 确认插件层进来了
& "D:\DSH\resources\runtime\cli\bin\dsh.cmd" --profile desktop --dump-config | Select-String novelnovel
# 4) 重开桌面端
```

`desktop` profile 是 `patchReload: live`，但改 `src/` 后仍然要 `npm run build` + 重开会话
（profile 加载的是 `lib/` 产物）。

⚠️ **桌面端的工作区根 = 那次会话选定的目录**。打开桌面端后在**你的小说目录**里开会话，
数据才会落在那里（`.novelnovel/`）；在别的目录开会话，`novel_project action=list` 会是空的。

### npm

还没发布到 npm。发布之后会是 `dsh plugin --profile web add dsh-novelnovel`，装的是预构建产物，
不需要任何构建授权。

### 装进哪个 profile

| profile | 用途 |
|---|---|
| `web` | 浏览器界面，交互式写作 |
| `headless` | 一次性任务：`dsh --profile headless "给《长夜将至》写第三章"` |
| `desktop` | DSH 桌面端（应用独占，只能按上面那节的方式装插件） |

⚠️ 只有 `web` / `headless` / `sdk` / `sdk-minimal` / `acp` 这五个名字会从自带模板自动初始化。
**自己起别的名字只会得到 `dsh-base` 一个 bundle，而 base 只是内核**——没有 Host、没有 HTTP、
没有一次性 runner，装上也用不了。`desktop` 不在其中：它由桌面端应用初始化，`dsh` 启动器会拒绝
`dsh --profile desktop`（但允许 `dsh plugin --profile desktop`，见上一节）。

### 验证装上了

```bash
# 浏览器端 / 一次性任务
dsh --profile web --dump-config | grep -i novelnovel          # 应能看到 # == dsh-novelnovel 那一层
# 桌面端（要用自带 CLI）
& "D:\DSH\resources\runtime\cli\bin\dsh.cmd" --profile desktop --dump-config | Select-String novelnovel
```

### 不支持从 git 直接安装

`dsh plugin add github:wanrenhuifu/NovelNovel` 装不起来：git 安装拉的是源码而不是构建产物，
本包没有 `prepare` 脚本，到手没有 `lib/`，加载会失败。请用上面的 tarball 路径。

### 从哪个目录启动

dsh 把**启动时所在的目录**当作工作区根：小说数据落在 `<那个目录>/.novelnovel/`，项目级技能落在
「最近的含 `.git` 的祖先目录」的 `.dsh/skills/`。所以先 `cd` 到你的小说目录再启动（桌面端则是
在小说目录里开会话）。

## 兼容性

**当前结论：适配 DSH 桌面端 `@deepseek-ai/dsh@0.2.0-rc.2`（DSH Desktop，Node 24.18.1）。**
核查方式（都可复跑）：

- 清单版本门槛用运行中的真品判定：`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`
  跑本包 manifest + 运行时版本 `0.2.0-rc.2` → 无冲突项（不兼容会在安装期就被拒，不会等到运行期）。
- `src/contract.ts` 镜像的 API 面逐项对照 `0.2.0-rc.2`：`ToolDefinition`/`defineTool`（仍支持
  author-only 的 `type:"json"` 与 `isConcurrencySafe`）、`ToolRunContext.agent.session.header.cwd`、
  `ctx.fs` 的读写与 `writeText` 五参签名、`fs/observed` 事件签名、`ctx.skills.register` 的
  runtime rank 250、`ctx.commands`、`ctx.systemPrompt` —— 均无签名差异。
- “先读后写”策略的归属判定也没变：`dsh-fs-observation-policy` 仍然从 `actor.agent.session`
  推导 owner，所以插件写入照旧记在调用方会话名下。
- 端到端：`npm run test:dsh` 49 项全过（其中一组走 `ctx.tools.execute` 真分发，参数与输出
  schema 都由 harness 校验）。

历史记录（保留，但已不是当前结论）：`0.1.5-rc.1`（npm `latest`，子包 `0.1.5-rc.2`）与
`0.1.2-rc.1` CLI + `0.1.3-alpha.2` 子包都验证过 40 项。

`package.json` 的 peerDependencies 用通配 `*`：插件运行时由 `src/harness.ts` 解析 harness 自己的包实例
（保证与运行中的 harness 同模块实例），不在依赖层面锁版本。`src/contract.ts` 是逐项比对后的手写副本——
上游改了签名要靠重新比对发现，所以升级 harness 后**重跑一次 `npm run test:dsh` 与 `npm run test:guard`**。

这一点与生态里多数插件的做法不同（它们写 `>=` 或 caret 区间，代价是 harness 一升级就可能装不上），
是本仓库有意的取舍：harness 还处在 developer preview，锁区间只会把上游的破坏性变更变成安装期的报错，
而真正的兼容性由 `contract.ts` 的逐项比对和端到端验证保证。

⚠️ **工作树里不要留 `@deepseek-ai/*` 的副本**（`node_modules/@deepseek-ai/` 里的旧版本就是这种情况）：
解析链一旦命中它，插件就会加载**第二份 harness**——服务按模块实例注册，双份会重复注册。
`src/harness.ts` 现在会校验解析结果的版本是否与运行中的 harness 一致，不一致就报错拒绝，
并告诉你修法；`npm run test:guard` 就是这条行为的用例。

## 用法

在装了插件的 profile 里开一个会话，直接用自然语言提写作需求即可；系统提示词会引导 agent 使用这些工具：

| 工具 | 作用 |
|---|---|
| `novel_project` | 作品的新建 / 列表 / 详情 / 改设定（简介、世界观、写作要求）/ 切换当前作品 / 删除 |
| `novel_chapter` | 章节列表（`from`/`limit` 分页、`verbose=false` 精简）、读取、新建、**追加（写正文的入口）**、覆写、改名、打标签、排序、检索、删除 |
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
    maxPrevChapterCount: 5        # 模型单次能要的前文章节数上限（默认 10，硬上限 20）
    maxPrevChapterChars: 8000     # 单章能摘取的字数上限（默认 20000）
```

非法配置（绝对路径、`..`、负数、超过硬上限）在加载期直接抛错，不静默取默认值。
后两项是**上下文预算的闸门**：不设上限时模型可以要求把整本书读进简报。

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
（`novel_project action=list` / `action=show` 里的**总字数**走的是按文件大小校验的缓存——
只在直接改文件时省一次重读，改过就重算，所以你改完文件再列作品看到的仍然是真实字数。）

技能不放在数据目录里，因为它是整个工作区的写作方法，不属于某部作品——见「装你自己的写作方法」。

## 设计说明

- **写入路径**：文本读写一律走 `ctx.fs`（受 harness 沙箱与权限策略约束、与 `write`/`edit`
  共用版本语义，并 `emit('fs/observed')` 让变更流与「先读后写」策略保持一致）。
  写入用**读取时拿到的版本**做 CAS 基准，所以「先读后改」的窗口里被别处改过时会失败并提示重新读取，
  而不是静默覆盖（索引、词条、预设、正文、工作区指针都走这条路；冲突会先自动重试几次）。
  `ctx.fs` 没有删除与二进制写入能力，删文件与写 PNG 头像用 `node:fs` —— 这条路径**不受沙箱约束**，
  所以插件自己兜住两道：目标必须落在会话工作目录内（`out_path=<工作区外>` 会报错），
  且**默认不覆盖已存在的文件**（`out_path` 是模型可控参数，否则一个 `action=export` 就能用 PNG
  字节盖掉任意工作区文件）。
- **损坏的数据文件（分级）**：整部作品读不出来（`project.json` 坏）→ 跳过并在
  `novel_project action=list` 里点名；单张角色卡 / `lorebook.json` / `presets.json` 坏 →
  跳过该文件、其余照常，写作简报仍然能组装；`workspace.json` 损坏 → 不致命，但多作品时解析
  「当前作品」必须显式传 `project=`——**宁可报错也不猜**，避免把正文写进错误的作品；
  `chapters/index.json` **损坏或缺失**都要当心：损坏直接报错，缺失时若 `chapters/` 里已有 `.md`
  则拒绝写入（静默当空索引会让下一次建章覆盖掉整份大纲）。数据文件都是给人手改的，
  读 JSON 时容忍 BOM 与 CRLF。
- **手工改动要守的不变量**：作品 id 就是**目录名**（`project.json` 里的 `id` 只是副本，
  不一致时该作品会被判为不可读并点名）；章节正文按 `<chapterId>.md` 命名，索引与正文要成对。
- **harness 依赖不内联**：`@deepseek-ai/*` 是 peer，运行时由 harness 自己提供——服务按模块实例注册，
  内联第二份会重复注册。以 `link:` 方式安装时包位于工作区之外，Node 从包 realpath 找不到 harness
  的依赖闭包，所以 `src/harness.ts` 会依次尝试：本包旁边 → harness 进程入口（`process.argv[1]`）→
  `$DSH_HOME/profiles` → 工作目录，并且**每个候选都要自证身份**：解析到的版本必须与运行中的
  harness 一致，否则报错退出（工作树里残留一份旧 `@deepseek-ai/*` 时，静默加载它会让插件用上
  第二份服务实例）。`npm run test:guard` 就是这条行为的用例。
- **API 契约副本**：`src/contract.ts` 是手写的最小类型契约（只含本插件用到的成员），
  依据 `@deepseek-ai/dsh@0.2.0-rc.2` 的真实签名整理。这样插件源码不依赖 harness
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
- **破坏性操作**：删除作品 / 章节 / 角色卡 / 词条 / 预设 / 导入的技能都需要 `confirm=true`，
  插件会拒绝未确认的调用，提示先与用户确认。
- **「读不出来」绝不用「没有」来表达**：数据文件是给人手改的，磁盘状态可能是半成品
  （`deleteChapter` 在"删正文"与"改索引"之间被中断、有人挪走了文件、SKILL.md 没写 frontmatter）。
  这类状态下工具**一律点名并说明原因**，而不是安静地当作空：
  - `novel_chapter action=list` 对索引里列着但正文不在的章节报
    `⚠ body file is missing on disk`，`novel_context` 对取不到的前文报
    `could not be excerpted`（否则续写会悄悄丢掉"上一章讲了什么"）；
  - `novel_skill action=list` 对解析不了的文件报 `could not be parsed and is NOT loaded`
    （否则表现为"技能明明放好了、工具说没有"）；
  - 坏作品目录、坏角色卡、坏词条文件同理，都在列表里点名，而不是消失。
  这条原则是踩出来的：同一个模式今天在三处独立出现过，每一处都表现为"工具说没有、其实东西在"。

## 开发

```bash
npm run build       # esbuild 打包到 lib/
npm run typecheck   # tsc -p .（严格模式，零错误）
npm test            # 9 个纯逻辑单测（卡解析 / 卡导出往返 / 预设+提示词 / 检索 / 排序 / 技能包 / 字数与词条匹配 / 客户端清单 / 客户端产物）
npm run test:guard  # 旧 harness 副本必须被拒绝加载（不需要装插件）
npm run test:dsh    # 端到端验证 54 项（默认 profile: novelnovel，用 DSH_TEST_PROFILE 覆盖）
npm run test:race   # 并发交错：CAS 真的挡住了吗（单次调用测不出静默覆盖）
npm run test:edge   # 边界语义：章节引用优先级 / keys 规范化 / 破坏性操作闸 / 半成品状态的点名
npm run test:compose    # 用宿主真实注册表验证客户端半边能组合
npm run test:sandbox    # 真实 sandboxPolicy：伪造 Session 会被拒 + 必须透传真 Session
npm run test:chapter-guard  # 章节 id 不能当路径段（越界 id 读不到别的作品）
npm run test:contract   # 文档契约：README 工具表承诺的 action 必须真实存在
npm run test:package    # 分发冒烟：npm pack → 解包 → 加载 → 技能与工具都注册
npm run test:render     # 面板渲染：react-dom/server 真渲染整棵面板（组件库走 shim）
npm run test:interaction # 面板交互：jsdom 真挂载，点击与键盘事件都真派发
npm run test:routes     # Web 路由：真 Request/Response 驱动三条 /api/novel.*，断言状态码与 JSON
npm run test:paging     # 章节列表分页：数 ctx.fs 调用与 summary 长度，证明分页真的省了
npm run test:words      # 字数缓存：直接改文件后字数仍会重算 + 缓存真的省调用
npm run test:lifecycle  # 生命周期：重复挂载会抛错、卸载后干净、能重新挂载（HMR 路径）
npm run test:prompt     # 系统提示词段：文本内容 + 组装位置 + 卸载后不留残留
npm run test:perf   # 性能探针：每个工具调用的耗时与 ctx.fs 调用次数
```

`test:dsh` / `test:perf` 会用 **DSH 自带的 Electron Node** 启动测试（harness 包在 `app.asar` 里，
普通 node 读不到），并自动探测安装目录；可用 `DSH_INSTALL` 指定，`DSH_TEST_PROFILE` 指定装了插件的
profile。harness 包的解析统一走 `tests/harness-loader.mjs`：**只认运行中的 DSH 安装**，仓库根残留的
旧副本不会被命中——否则测试进程里会出现第二份服务实例，测出来的东西没有意义。

`npm run test:dsh` 会拉起真实 harness 服务（SystemPrompt + ToolRuntime + LocalFileSystem +
SkillRegistry + observation policy）并驱动全部工具：作品/章节/词条/角色卡（含 PNG 双写回读）/预设/
简报组装/关键词注入命中与未命中/检索/导出/技能注册（按 `skills/` 里的 SKILL.md 逐个核对）/项目级技能
（技能包导入→列出→导出→再导入→删除，含手写技能不被覆盖、校验失败不写一半）/命令处理器/配置校验/
工作区边界与损坏文件容错（坏作品目录、坏角色卡、索引缺失、拒绝覆盖已有文件、追加空白保真、
`position`/`limit` 边界、同名预设）/观察记录归属/真分发链路（`ctx.tools.execute`：参数校验 + 输出
schema）/卸载清理/系统提示词段，共 49 项检查，不调用模型。
`npm test` 是它的快速补充：7 个纯逻辑单测直接测 `src/domain/` 里的解析与组装函数，
其中「导入 → 改字段 → 导出 → 再导入」专门守着「改了角色卡再导出不会退回旧值」这条。

`tests/perf-probe.mjs` 是性能探针（`npm run test:perf`）：铺 3 部 × 200 章，
打印每个工具调用的耗时与 `ctx.fs` 调用次数。解析作品引用只读元数据、统计字数才读正文，
这条边界靠它守住——把正文读回解析路径会让一次 `action=append` 的调用数从 39 涨到 1839。
