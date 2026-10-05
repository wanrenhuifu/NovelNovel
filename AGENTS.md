# AGENTS.md

DeepSeek Harness (dsh) 插件（npm 包 `dsh-novelnovel`）：把小说写成**工作区里的普通文件**，让 harness 的
agent 直接用 `novel_*` 工具写作、导卡、维护设定、检索、导出。不发模型请求（模型由 harness 提供），
数据落 `<工作目录>/<dataDir>/`。领域逻辑集中在 `src/domain/`。

两个半边：**宿主半边**（Node，工具/技能/命令 + 3 条只读 `/api/novel.*` 路由）与
**客户端半边**（浏览器，DSH 侧栏的「NovelNovel」写作面板，只读）。客户端半边是可选能力——
`dsh.client` 是唯一的声明点，但它一旦声明，产物缺失就会**启动即崩**（见「坑」）。

写作方法由技能承载：6 个技能随包注册（rank 250），用户自己的方法用 `novel_skill` 导入到项目根的
`.dsh/skills/`（rank 100，会覆盖同名内置技能）——那是唯一落在 `<dataDir>` 之外的写入。

MIT 许可（`LICENSE`）。分发走 `npm pack` 的 tarball（`prepack` 自动构建）；`package.json` 已处于
可发布状态（无 `private`，`files`/元信息齐全），但**尚未发到 npm**——README 里 npm 那段是按
"未发布"写的，真发出去之后要同步改。

## 命令

```bash
npm run build       # esbuild → lib/index.js（lib/ 不入库；改完 src 必须重建，profile 加载的是产物）
npm run typecheck   # tsc -p .（严格模式，noUnusedLocals/Parameters，零错误才过）
npm test            # 9 个纯逻辑单测（下面 9 个脚本）
node scripts/test-card-import.mjs   # 角色卡解析链路（PNG V2 / ccv3 双写 / JSON / V1 / 世界书并入 / 关键词拆分）
node scripts/test-card-export.mjs   # 角色卡导出往返（编辑后再导出不回退、V1 字段不丢、非 PNG 头像占位、魔数嗅探）
node scripts/test-preset-import.mjs # 预设导入解析 + story_string 渲染（含空变量报警与 {{char}}）+ 提示词组装 + 截断
node scripts/test-search.mjs        # 章节全文搜索：命中/摘要/标题/上限/顺序/全半角/长度变化的小写折叠
node scripts/test-reorder.mjs       # 章节排序：边界/位移/规范化/不可变性
node scripts/test-skill-pack.mjs    # 技能包解析 + SKILL.md frontmatter 往返 + 项目根祖先链
node scripts/test-domain-utils.mjs  # 字数统计（标点与扩展 B 汉字）+ 词条关键词匹配（全半角、空白键）
node scripts/test-client-manifest.mjs # 客户端半边清单：dsh.client 形态 + exports["./client"] + **产物必须存在**
node scripts/test-client-bundle.mjs   # 客户端产物：包装格式、external 无漏项、slot 注册冒烟
npm run test:guard                  # 旧 harness 副本必须被拒绝加载（子进程里造一份假副本，不需要装插件）
npm run test:hygiene                # 测试不许污染用户 profile + **每个装了插件的 profile 都验一遍**
npm run test:dsh                    # 54 项端到端检查：真实 harness 服务上驱动全部工具（不调模型）
npm run test:compose                # 用宿主真实 ClientModuleRegistry 验证客户端半边能组合（走 DSH 的 Node）
npm run test:sandbox                # 真实 sandboxPolicy：伪造 Session 会被拒 + store 必须透传真品
npm run test:chapter-guard          # 真实 fs 语义：章节 id 不能当路径段（越界 id 读不到别的作品）
npm run test:race                   # 并发交错：CAS 真的挡住了吗（用 fs 钩子构造交错，CAS 正确性只能这样证明）
npm run test:edge                   # 边界语义：章节引用优先级 / keys 规范化 / 破坏性操作闸 / 缺失正文的点名
npm run test:contract               # 文档契约：README 工具表承诺的 action 必须真实存在（双向）
npm run test:package                # 分发冒烟：npm pack → 解包 → 加载 → 技能与工具都注册
npm run test:render                 # 面板渲染：react-dom/server 真渲染整棵面板（组件库走 shim）
npm run test:interaction            # 面板交互：jsdom 真挂载，点击与键盘事件都真派发
npm run test:routes                 # Web 路由：真 Request/Response 驱动三条 /api/novel.*，断言状态码与 JSON
npm run test:paging                 # 章节列表分页：数 ctx.fs 调用与 summary 长度，证明分页真的省了
npm run test:words                  # 字数缓存：改文件后字数仍重算（README 的承诺）+ 缓存真的省调用
npm run test:lifecycle              # 生命周期：重复挂载会抛错、卸载后干净、能重新挂载
npm run test:prompt                 # 系统提示词段：文本内容 + 组装位置 + 卸载后不留残留
npm run test:skills                 # 自带技能：中文触发词必须在 description 里（whenToUse 不进提示词）
npm run test:primitives             # 客户端 import 的组件库导出名必须在真实产物里存在
npm run test:tokens                 # styles.ts 用到的 CSS 变量必须在首方产物里存在
npm run test:perf                   # 性能探针（带 ctx.fs 调用计数）
```

端到端与性能探针统一走 `npm run test:*` 的启动器（`scripts/dsh-node-launcher.mjs`）：它们用
**DSH 自带的 Electron Node** 跑 `tests/verify.mjs` / `tests/perf-probe.mjs`（harness 包在 `app.asar`
里，普通 node 读不到），cwd 是一个**一次性临时目录**并注入 `DSH_ENTRY`/`DSH_INSTALL`/`NN_TEST_CWD`。
**cwd 绝不能是 profile 目录**：曾经是，于是走 `process.cwd()` 的探针把三本空作品写进了用户的
`~/.dsh/profiles/<name>/`；插件与 harness 的解析靠 profile 锚点与安装路径、**不依赖 cwd**，
所以换成临时目录不影响任何解析（`npm run test:hygiene` 守着这条，静态+动态两道）。
安装目录自动探测，
可用 `DSH_INSTALL` 指定；**测试用哪个 profile 只认 `DSH_TEST_PROFILE`（默认 novelnovel）**——
不读会话里的 `DSH_PROFILE`（桌面端会话里它是 `desktop`，插件不一定装在那儿）。
无 lint 配置。仓库是 git 仓库（origin = `wanrenhuifu/NovelNovel`），提交信息沿用
`feat: 中文摘要（、分隔）` + `- 主题：说明` 列表体。

## 架构边界

- `src/index.ts` 插件入口：`name` / `inject`（硬依赖 `tools`+`fs`）/ `resolveConfig` / `apply`
  —— 注册工具、`ctx.inject` 软挂载技能、命令与系统提示词段（order 4500）。
- `src/contract.ts` 手写的 harness API 最小类型契约（**只有类型、没有运行时**）；运行时真品由
  `src/harness.ts` 解析（`src/harness.ts` 的解析顺序见「坑」）。
- `src/store.ts` 工作区文件存储（作品/章节/词条/角色卡/预设）+ `NovelStore` 的 patch 具名类型；
  `src/skillStore.ts` 管**项目级**技能文件（项目根 `.dsh/skills/` 的列出/导入/导出/删除，加载仍由
  harness 负责，不新增技能机制）；`src/fsx.ts` 封装 `ctx.fs`（解析/读写/目录/删除/二进制）与会话构造；
  `src/types.ts` 落盘结构。
- `src/tools/<name>.ts` 一个工具一个文件，`src/tools/index.ts` 注册；`src/tools/shared.ts` 放统一输出
  形状（`TEXT_OUTPUT`/`textRender`）、`lines`/`preview`/`requireFields` 与 `ToolDeps`。
- `src/skills.ts` 枚举 `skills/*/SKILL.md` 并 `ctx.skills.register` 运行时注册（另导出
  `bundledSkillNames` 供 novel_skill 判断同名覆盖）；`src/command.ts` 是 `/novel` 命令
  （把当前作品状态以文本返回，不经过模型）。
- `src/domain/` 纯逻辑，**不 import harness、不碰文件系统**（连 `node:*` 都不引，路径运算自己写）：
  `cardImport.ts`（角色卡解析 + 世界书提取）、`presetImport.ts`、`prompt.ts`（系统提示词组装、宏替换、
  词条注入、续写消息拼装）、`search.ts` / `reorder.ts`（id 泛化为 `string | number`）、
  `export.ts`（正文拼装 + 角色卡 PNG 再导出）、`png.ts`（chunk 读写 + deflate）、
  `skillFrontmatter.ts`（SKILL.md 解析/渲染，两条投递路径共用）、`skillPack.ts`（技能包解析 +
  项目根祖先链）、`utils.ts`、`types.ts`。
- `src/clientApi.ts` 宿主侧的 Web 接口：3 条**只读** `/api/novel.*` 路由（作品列表 / 作品详情 /
  章节正文）。复用 `NovelStore`，不重写领域逻辑；鉴权完全交给 connection 的 fence。
- `src/client/` **客户端半边**（浏览器）：`index.tsx` 注册 `sidebar.panellist` 图标与 `main` 面板、
  `panel.tsx` 是只读视图、`state.ts` 是取数与选择状态、`api.ts` 走文档相对路径请求宿主路由、
  `styles.ts` 注入 CSS（`--dsw-*` token）、`env.d.ts` 补平台模块的类型声明。
  构建产物 `lib/client.js` 由 `build.client.mjs` 包装（**不是 ESM**，见「坑」）。
- `tests/verify.mjs` 端到端（54 项）；`tests/harness-loader.mjs` 是测试侧的 harness 解析器
  （锚点顺序、`registerHarnessHook` 见「坑」）；`tests/verify-client-compose.mjs` 用宿主真实的
  `ClientModuleRegistry` 验证客户端半边能组合；`scripts/dsh-node-launcher.mjs` 负责用 DSH 自带的
  Electron Node 起测试，`scripts/verify-dsh.mjs` / `scripts/verify-client-compose.mjs` /
  `scripts/probe-dsh-perf.mjs` 是它的三个入口；`scripts/client-platform-modules.mjs` 是
  external 白名单的**单一来源**（构建与测试共用）；`tests/fixtures/stale-harness.mjs` +
  `scripts/test-harness-guard.mjs` 是「旧副本必须被拒绝」的用例；`samples/preset-example.json`
  供测试导入预设用。

## 约定

- 模型可见的字符串用**英文**：工具 `description`/参数说明/`summary`，以及 SKILL.md 的 frontmatter
  与正文（`description` 就是模型唯一能看到的路由判据，harness 对工具 schema 和技能都没有本地化
  机制）。中文留给 README、AGENTS.md、代码注释。
  **但技能的 `description` 必须带中文触发词**（`润色`/`断章` 这类）——这条被实测纠正过：
  技能目录的模板（`@deepseek-ai/dsh-tool-skill` 的 catalog template）是
  `` - `<name>`: <normalized-and-capped-description> ``，**只列 `description`，`whenToUse` 不进提示词**
  （后者只出现在 API 控制器的技能列表里，是给面板/外部消费者用的元数据）。
  所以"中文触发词写在 `whenToUse` 里"曾经等于白写：实测把提示词全组装出来后，
  `润色`/`改写`/`去 AI 味`/`断章` **一个都没出现**。现在 6 个技能的 `description` 末尾都带
  `中文触发：…`，由 `npm run test:skills` 守着。
  只读类工具声明 `isConcurrencySafe`，会写文件的不要声明。
- 危险操作（删作品/章节/角色卡/导入的技能）必须 `confirm=true` 才执行，错误信息提示先问用户；
  会覆盖别人文件的（技能包导入）用 `overwrite=true` 同理。
- `update*` 的 patch 用 `store.ts` 导出的具名类型，不写 `Record<string, …>`。
- 新增工具：`src/tools/<name>.ts` + 在 `src/tools/index.ts` 注册；模型可见的字符串
  （description/parameters/summary）改动要同步 README 的工具表。
- 注释只写约束性说明，不复述代码。

## 坑（改相关代码前必读）

- **harness 依赖**：`@deepseek-ai/*` 声明为 peer + esbuild `external`，**绝不能内联**——服务按模块
  实例注册，产物里第二份会重复注册。以 `link:` 方式安装时包在工作区之外，Node 从包 realpath 找不到
  harness 的依赖闭包，所以 `src/harness.ts` 按「本包旁边 → harness 进程入口 `process.argv[1]` →
  `$DSH_HOME/profiles` → cwd」依次解析，命中即用。但**命中不算数**：每个候选都要过
  `assertRuntimeCopy`——解析到的版本必须满足本包清单的 peer（`*` 这类判不了就要求与运行时版本相等；
  运行时版本取自 `@deepseek-ai/dsh-app-boot`，只信「本包旁边 / 进程入口 / profiles」这三个锚点，
  **有意不信 cwd**，否则工作树里的旧副本会把自己变成基准）。连运行时版本都定不下来也报错——
  放行等于把「第二份 harness」留到运行期才炸。用例：`npm run test:guard`（在子进程里造一份假旧副本，
  不需要装插件）。Desktop 上 profile 解析器（`routeLinked`）会看本包 `peerDependencies` 里的名字并
  路由到应用安装，所以新增 `@deepseek-ai/*` 的 import 时**必须同步加进 peerDependencies**，否则会
  落到工作树里那份。
  `@lenml/char-card-reader` 是 AGPL，只做 external + `dependencies`，不打进产物。
- **客户端半边：声明了就必须有产物，否则启动即崩**（踩过一次，整台机器的前端都打不开）。
  `package.json` 的 `dsh.client` 是**唯一**声明点，宿主 `ClientModuleRegistry` 构造时会扫每个 loader 行，
  对声明了 `dsh.client` 的包读 `exports["./client"]` 指向的文件：**读不到就抛
  `MissingClientBundleError`，聚合成 `ClientPackageCompositionError` 同步抛出** → 注册表不注册 →
  `/plugins` 路由不存在 → **所有客户端插件（含首方）都加载不出来**。所以：
  - 产物 `lib/client.js` 由 `build.client.mjs` 生成，`lib/` 不入库，**新克隆必须先 `npm run build`**；
  - `npm test` 里的 `test-client-manifest.mjs`（清单层，纯 Node）与 `npm run test:compose`
    （用宿主**真实注册表**验证组合，走 DSH 的 Node）就是为这条设的，改客户端半边后两个都要跑；
  - 产物的形态是**经典 script**，不是 ESM 也不是 Node CJS 模块：
    `window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => { var module = {exports:{}}; …; return module.exports } })`，
    `factory` 只收 `require` 一个参数；
  - `require` 的说明符必须是外壳**静态模块表**里的精确键（`scripts/client-platform-modules.mjs`
    是唯一来源），写成 `"…/client"` 之类的子路径会在**浏览器 console** 报
    `missed the module table`——服务端完全看不到这条错误，所以它由 `test-client-bundle.mjs` 兜住；
  - `platform` 不是 `"web"` 会被**静默**当成非客户端包（无报错、页面里也没有），最难查的一种；
  - 组合与 bundle 清单是**增量扫描**（只在 fiber 构建/销毁时重扫，没有全量重扫路径）：新装包或
    首次补上产物后**必须重启应用**，之后改产物才走 HMR；而本机没有跑 `pnpm run dev:web`，
    所以 HMR 也不会重建产物——**每次改客户端代码都要 `npm run build`，再重启应用**。
- **工具参数名就是 schema 键**：`defineTool` 的 `args` 类型由 `parameters` 推导（`contract.ts` 的
  `InferArgs`），schema 里写 `author_note`/`prev_chapters` 这类 snake_case，代码里就必须同名访问
  ——改 schema 键名不改进代码会直接 tsc 报错（有意的防漂移，别用 `any` 绕）。
- **写文件**：`ctx.fs.writeText` 传 `{kind:'createIfAbsent'}` 命中已存在文件会报 `FS_NOT_OBSERVED`
  （本地后端要求先读后写），所以 `fsx.ts` 先 `stat`：已存在用 `replaceIfVersion`（带 stale 校验），
  不存在用 `createIfAbsent`，写完 `emit('fs/observed')` 并**把触发调用的 exec 作为第三参传入**
  （`FsSession.actor`）——observation policy 只对能解析出 session 的 actor 记录观察
  （`if (owner) this.set(...)`，owner 取自 `actor?.agent?.session`，0.2.0-rc.2 仍然如此），不传就等于
  这些写入对「先读后写」策略不存在，首方 `write`/`edit` 之后会被要求先读一遍。`writeText` 的第五参
  是 `SandboxExecutionPolicy`：**会话策略要透传**（`ctx.get('sandboxPolicy')?.resolve({ session })`），
  不传则 fs 后端退回部署默认（`dsh-fs-sandbox` 里 `sandboxPolicy ?? ctx.sandboxPolicy.resolve()`）。
  `ctx.fs` 没有删除与二进制写入能力，删文件/写头像图片是 `node:fs` + `ctx.fs.processPath`——这条路径
  **不受沙箱约束**，因此 `writeBytes` 自己兜两道：`assertInsideWorkspace`（只能落在会话工作目录内）
  与**默认拒绝覆盖已存在的文件**（`out_path` 是 agent 可控参数，否则一个 `action=export` 就能用 PNG
  字节盖掉任意工作区文件；要覆盖旧导出得显式传 `overwrite`）。别删这两个检查。
- **「先读后改」必须传 CAS 基准**：`fsx.writeText/writeJson` 的第四参 `expected: VersionBasis`
  （读文件时拿到的 `version` + `existed`）——**不传就在写入前重新 `stat`**，那等于拿「刚读到的最新
  版本」当基准，读-改-写窗口里的并发改动会被**静默覆盖**（CAS 永远通过）。所以 store 里所有
  读-改-写都走 `readJsonVersioned` / `readChapterBodyVersioned` 并把 basis 传给写入，
  外层套 `withStaleRetry`（冲突重试几次，耗尽后抛「re-read it and retry」）。
  判定冲突靠 `isStaleVersion`（fs-local 的 `FS_STALE_VERSION`）。注意 `readJsonOrDiagnose`
  是**宽松读**（坏文件跳过并报原因），只给「不该让一个坏文件堵死整个入口」的展示路径用；
  决定写入的读必须是严格的 `readJsonVersioned` / `readXStrict`，否则坏文件会被当成空值覆盖掉。
- **`ctx.waterfall` 的末参是 fallback**：`ctx.waterfall(event, ...args, fallback)`——不给 fallback 时，
  最后一个业务参数会被当成 fallback 吞掉（表现为监听器收到的 `actor` 是 undefined，极易误判成
  "策略不记录"）。测试里要写成 `ctx.waterfall('fs/write-intent', target, exec, () => undefined)`。
- **损坏数据文件的处理分级**：`project.json` 读不出来 → 跳过该作品目录并在 `novel_project action=list`
  里点名；单张 `characters/*.json` / `lorebook.json` / `presets.json` 坏 → 跳过该文件（走
  `listCharactersDiagnosed` / `readLorebookDiagnosed` / `readPresetsDiagnosed`），写作简报仍能组装；
  `workspace.json` 读不出来 → 不致命，但多作品时解析「当前作品」必须显式传 `project=`
  （宁可报错也不猜，避免写错作品）；`chapters/index.json` **损坏**直接报错。数据文件是给人手改的，
  `readJson` 容忍 BOM/CRLF。
  两条容易搞反、都踩过的口径：
  - **写索引的安全闸按内容判，不按存在性判**（`assertNoOrphanChapters`，在 `writeChapterIndex` 里）：
    索引被改成 `{}`/`[]`/`null` 时 JSON **能解析**、`basis.existed === true`，旧的存在性判定会放行，
    接着写入「只含新章」的索引 → 全书大纲一次性消失。判据必须是「目录里有没有索引未引用的 `.md`」。
  - **`workspace.json` 坏掉时要能自愈**：`readJsonVersioned` 的 `existed` 说的是「有没有读出值」，
    不是「文件在不在」。坏文件若报 `existed: false`，写指针就会选 `createIfAbsent`、撞上那个坏文件
    报 `FS_NOT_OBSERVED`（"cannot overwrite … without reading it first"），于是 `action=create` /
    `action=use` 全失败、文案还指向"你没先读它"。所以 `readWorkspace` 单独读一次文本，
    **坏文件保留它的版本当 CAS 基准**，写入直接覆盖修复。
- **没有真实会话工作区时一律拒绝写入**（`FsOps.assertWritable`）：`sessionFor` 在
  `header.cwd` 缺失或为空时把 cwd 兜底成 `process.cwd()` 并打上 `ephemeral: true`
  （判**空值**而不是 `undefined`——`dsh-tools` 在 exec 缺 agent 时会自己合成 `{header:{cwd:""}}`）。
  这种会话只能读：写入会静默落进 `process.cwd()`，桌面端即应用安装目录，用户工作区里什么都没有，
  那个目录也不在面板白名单里（既看不到也选不中）。写/删/字节写入四个入口都过这道闸。
  同一个闸还查取消信号（`NN_ABORTED`）：多步序列里不可逆的那一步（node:fs 的 rm、头像 writeFile）
  本来完全不理会取消。**实测澄清**：主路径上 `ctx.fs.resolve` 自己就会拒绝（`resolve aborted`），
  所以取消并不会真的落地——插件这道检查是纵深防御，别把它当成唯一的防线。
- **harness 版本守卫的两条边界**（都实测过，别改回去）：`runtimeVersion()` 的基准锚点
  **不含 cwd**（`trustedAnchors()` 与 `resolutionAnchors()` 是两份清单：后者含 cwd 供模块解析用，
  前者供版本基准用）——混进 cwd 会让工作树里的旧副本变成基准并缓存进 `state.runtime`，
  此后每个候选都拿错基准比，守卫空转；`assertRuntimeCopy` 里**读不到那一份的版本必须报错**，
  不能放行（`packageVersion` 的手工 `..` 路径在入口是嵌套形态时会指向无关的 package.json）。
- **目录名就是作品 id**：`scanProjectDirs` 以目录名为权威，`project.json` 里的 `id` 与它不一致时
  该作品被判为不可读并点名（否则「列表显示 A、写入落在 B」）。复制/改名作品目录是用户很自然的
  备份手段，这条防的就是它。
- **技能注册**：不用 `skill-filesystem` 的 `customSkillDirs`——那是 `dsh-base` 的行 config，覆盖它要
  重述整份 config（patch 是整行替换），随上游变化即失效；改走 `ctx.skills.register`（rank 250，
  项目级技能 rank 100/200 仍可覆盖同名插件技能）。SKILL.md 里 `disable-model-invocation` /
  `user-invocable` 是正规键，`modelInvocable` 这类旧键会被 harness 直接拒绝。技能名必须是
  kebab-case `^[a-z0-9]+(?:-[a-z0-9]+)*$`，不合规的候选会被本地 provider 判为 malformed——所以
  `parseSkillFile` 在**解析阶段**就校验，而不是等 harness 静默丢掉它。
- **项目级技能的落点是「最近的含 `.git` 的祖先目录」**，不是 cwd——harness 的本地 provider 就这么解析
  项目根。会话开在 git 仓库子目录里时项目根在 cwd 之外，而插件不往工作区外写，所以
  `SkillStore.skillsRoot` 用 `ctx.fs.contains` 校验后**拒绝**并说明原因，而不是默默写到
  `<cwd>/.dsh/skills` 让工具报成功、harness 却永远不加载（祖先链是 `skillPack.ancestorDirs`，
  纯字符串运算，`\` 与 `/` 都容忍；漏了 `parent === current` 的终止条件会让单段相对路径死循环，
  单测里专门盯了这条）。导入先全量校验再落盘；没有 `.novelnovel-skill.json` 标记的技能（用户手写的）
  一律不覆盖、不删除。标记写在技能目录里当普通资源文件——harness 只把 SKILL.md 当目录变更。
- **frontmatter 是逐行 `key: value` 解析的**：`description`/`whenToUse` 里混进换行会静默吃掉后面
  所有字段，所以技能包导入时就把多行值拦下来（`requireSingleLine`），渲染后还回读一次自证
  （`renderPackedSkill`）。只按行内第一个冒号切分，所以值里带冒号是合法的。
- **`slice(-0)` 陷阱**：`recent_chars`/`prev_chars` 为 0 时要显式判 `> 0` 再 `slice(-n)`，
  否则 `slice(-0)` 等于 `slice(0)`，会取到整章（`tools/context.ts` 与 `store.previousExcerpts` 各一处）。
- **解析作品与统计字数分开**：`resolveProjectId` 走 `listProjectRefs`（每个作品只读 `project.json` +
  `chapters/index.json`），读遍全书算字数的 `listProjects` 只服务 `novel_project action=list` 与
  `/novel list`；`previousExcerpts` 先用 `listChapterMetas` 定位再按需读正文。别把正文读回解析路径
  ——实测一次 `action=append` 的 `ctx.fs` 调用会从 39 涨到 1839（409ms→47ms）；`tests/perf-probe.mjs`
  可复测（带调用计数）。
- **预设与文件名的不变量**：同名预设重导入必须**沿用原 id**（否则 `activePresetId` 悬空 → 简报静默
  退回内置默认提示词，而列表仍显示有激活项），且替换后要**按新 kind 重算激活指针**
  （`reconcileActivePreset`：换成 instruct 就不再参与组装，返回里的 `replacedActive` 如实反映）；
  `action=add` 同名直接拒绝（同名并存会让 `resolvePreset` 的精确匹配永远命中第一个）；
  章节正文按 `<chapterId>.md`、角色卡按 `<id>.json` + 头像按真实媒体类型的扩展名存放；
  id 一旦生成不再改名（`ctx.fs` 没有 rename，重命名会牵动全部引用）。
- **写入顺序 = 失败后能看懂**：`createChapter` 先写正文再写索引（失败只留可见的孤儿 `.md`），
  `deleteChapter` 先删正文再改索引（反过来会「索引说没了、文件还在，且工具报错」）；
  `importCharacter` 落盘前先 `readLorebookStrict` 预检，并把「写头像 → 写卡片 → 合并词条」
  三步放进**同一个 try**、共用同一个回滚：头像走 node:fs（不受沙箱与取消约束），卡片那步失败或
  被取消会留下「有头像没 .json」的残骸，而读路径只扫 `*.json`，那个头像既不显示也不清理；
  词条合并失败不回滚则模型重试会再建一张同名卡，两张都 active 都进简报。
  另外 `createProject` 的四个初始文件一律 `overwrite: false`：slug 是「先 listDir 再挑一个没被占用的」，
  并发建同名作品会选中同一个目录，不带这道闸时后写者会把先写者的 project.json / 世界书 / 章节索引
  **全部静默覆盖**（两次都报成功）。
- **角色卡**：`@lenml/char-card-reader` 把 V1 卡的 `spec` 标为 `"unknown"`；`cardImport.ts` 的
  `specToVersion` 把非 v2/v3 归为 v1，别"修复"它。头像一律以字节表达（PNG 卡取原文件字节，JSON 卡把
  `get_avatar()` 的 data URL 解成字节），落盘扩展名按媒体类型；**取不到头像时要给 `avatarNote`**
  （JSON 卡存外链 URL 时本插件不联网抓取，不说明用户会以为头像导进来了）。`rawData` 必须无损保留
  原始 JSON，但**它只是未知键的底本**：导出时存储字段（name/description/personality/scenario/
  first_mes/mes_example/creator_notes/creator）是权威——从 rawData 重建会把
  `novel_character action=update` 改过的值悄悄换回旧值。入口是 `parseCharacterBytes`
  （字节 + 文件名 + 媒体类型），没有 File/Blob 版本；解析前先按**魔数**嗅探图片，避免
  「.webp 改名成 .json」被当成 JSON 解析而报出误导性的错误。
- **世界书导入**：`cardImport.ts` 的 `extractLorebookEntries` 把 character_book 词条并入项目
  lorebook。`{{char}}`/`{{user}}` 宏**在导入时**就按来源卡名/“主角”替换（`replaceMacros`）——项目
  lorebook 混合多卡来源，留到组装时已无法确定 `{{char}}` 指向谁；关键词 `keys` 保持原文不替换
  （要用于上下文匹配），但要**在导入时拆开**：存储格式是「逗号分隔的字符串」，注入时按 `[,，]` 切，
  所以单键里的逗号（`["a,b"]`）会变成两个键、只有空白的键（`[" "]`）会静默退化成「常驻注入」。
  词条名优先 `entry_name`→`name`→`comment`→首个关键词；空内容条目直接丢弃；`enabled` 缺失视为启用。
  词条 id 由 store 生成后并入项目 lorebook。合并前的去重键是 `name\0content`，所以**改了卡里的
  词条内容再导入会新增一条**（旧的还在）——这是已知取舍，见「还没做」。
- **角色卡 PNG 再导出**：`domain/export.ts` 把任意来源的卡统一转 V2 结构写 `chara` chunk，有 V3
  rawData 时另写 `ccv3`（读取端 ccv3 优先）；头像非 PNG（或缺失）时用纯色占位图。TS 5.8 下传给
  Blob 的必须是 `Uint8Array<ArrayBuffer>`。
- **Lorebook 注入语义**：`domain/prompt.ts` 的 `selectLoreEntries` —— 词条 keys 为空 = 常驻注入；
  有 keys 时仅当任一关键词（逗号分隔、**大小写与全半角归一化后**）出现在续写上下文里才注入。
  拆分规则只有 `splitLoreKeys` 一份实现（读取侧与写入侧共用），写入侧由 `normalizeLoreKeys`
  规范化成「逗号 + 空格」——否则 `keys=",,"` 拆完是空数组、会被当成**常驻注入**（每回合全文
  进提示词），而列表显示"有关键词"。改语义时同步更新 `skills/novel-cards/SKILL.md` 与 README。
- **写作预设**：`presetImport.ts` 按字段特征识别裸预设（`content`→system、`story_string`→context、
  `input_sequence`→instruct），含 `context`/`sysprompt`/`instruct` 子对象则当合订信封；reasoning 直接
  拒绝；**声明了字段但内容是空串的裸预设也拒绝**（导入它等于什么都不改，静默成功最误导）。
  `buildSystemPrompt` 返回 `{ text, warnings }`：`systemPrompt` 替换开场白（过 `replaceMacros`），
  `storyString` 走 `renderStoryString` 替换默认设定区块，渲染后**比对该模板引用了哪些变量、
  哪些是空的**并报进 warnings（`wiAfter` 恒空，模板只写它会整块丢掉设定）。`story_string` 的
  `system` 变量映射本项目"写作要求"，lorebook 统一放 `wiBefore`，而 `char`/`user` 必须进变量表——
  否则 `{{char}}` 会被 `?? ""` 静默替成空串，`{{#if char}}` 恒假。
- **安装与调试**：改完 `src/` 必须 `npm run build`（`lib/` 不入库，profile 加载的是产物）；
  `link:` 安装后改动只需重建 + 重开 dsh 会话，tarball 安装则要重新 `npm pack` + `dsh plugin add`
  ——`prepack` 挂的就是 `npm run build`，所以 `npm pack` 出来的一定带 `lib/`，不必先手动构建。
  **装进哪个 profile 有讲究**：只有 `web`/`headless`/`sdk`/`sdk-minimal`/`acp` 这五个名字会从自带
  模板自动初始化，其他名字只得到 `dsh-base` 一个 bundle——而 base 只是内核（无 Host、无 HTTP、
  无 runner），没有可交互面。
  **`desktop` 是另一回事**：桌面端应用独占它（`dsh --profile desktop` 启动会被拒），但**插件管理支持**
  ——桌面端自带的 CLI wrapper（`<安装>\resources\runtime\cli\bin\dsh.cmd`，内部以
  `manageDesktopProfile: true` 调 `runCli`）允许 `dsh plugin --profile desktop add|remove`，
  前提是先**完全退出**应用（它持有 profile 的 `package.json` 锁）。别照旧文档说「会被拒」。
  插件的观测口径（工具、技能、命令）都以 `npm run test:dsh` 为准。

## 还没做（已知缺口，改到附近时顺手评估）

- **词条来源标记**：导入去重只比 `name\0content`，改了卡里的词条再导入会新增一条（旧的还在）。
  彻底解决要给词条记来源（哪个卡、第几条）并在重导入时更新，代价是 `lorebook.json` 加字段 + 迁移。
- **没有 `restore`**：`novel_export action=backup` 能导出，但导回来只能手工铺文件。
- **`action=write` 覆盖正文没有历史**：`append` 是常规路径，`write` 是整体替换，目前没有快照。
  **修完 CAS 后行为变了**：`writeChapterBody` 会自己先读一次正文拿基准，所以"模型 read 之后、
  write 之前有人改了文件"现在会**明确失败**（`cannot write … stale`）而不是静默覆盖——
  模型必须重新 read 再 write。这是有意的取舍（宁可失败也不无声丢字），但意味着覆盖失败的
  报错会变常见，别把它当异常。
- **list/search 的最终上限**：`novel_chapter action=list` 支持 `from`/`limit`/`verbose=false`
  分页与精简（见下方实测数字），但**默认仍是全量且带预览**——模型不主动分页时照样会吃掉一大段上下文。
  `action=search` 有 `limit`（默认 50），命中的摘要长度固定，不需要分页。
  `novel_project action=list` / `action=show` 的**总字数**已改成按文件大小校验的缓存
  （`ChapterMeta.wordsCache`，一次 `listDir` 拿全目录大小），不再读遍全书：实测 300 章
  从 923/929 次 `ctx.fs` 调用降到 15/29 次。`novel_chapter action=list` **不走缓存**，
  它按 README 的承诺重新读文件。
- **面板只读**：`src/client/` 的写作面板不做写入——写要与模型抢同一份稿子，得先设计冲突 UX
  并复用 CAS 语义，留到第二期。
- **面板还不知道「当前工作区」**：HTTP 路由没有会话上下文，所以工作目录靠 `NovelStore` 记录的
  「工具真正用过的目录」当白名单，单工作区时自动解析。多工作区且工具尚未跑过时面板只能提示
  用户先调用任意 `novel_*` 工具（见 `unknown_workspace` 那条 403 与 `state.ts` 的文案）。
- **从未跑过真实模型会话**：全部验证都在工具层，不调模型——技能路由、简报实际 token 量、
  模型会不会滥用 `action=write` 都还没有证据。

## 参考

- `README.md`：安装（含桌面端）、工具表、配置、数据布局、设计说明。
- dsh 插件开发文档：`docs/user/develop/**` 与 `docs/subsystems/*.md` 只存在于上游源码仓库
  （github.com/deepseek-ai/deepseek-harness），**本机安装里没有**——`D:\DSH\resources\app.asar`
  内只有 `lib/` 与 `node_modules/`，既没有 `docs/` 也没有 `src/`、`apps/`、`packages/`。
  真实 API 以安装内 `@deepseek-ai/*/lib/types/*.d.ts`、打包后的 `lib/*.js`，
  以及运行中的 `cordis_inspect_*` 探针（Service / Event / Config / Slot）为准。
- 技能子系统（rank 表、frontmatter 键、注册与覆盖语义）：看安装内 `@deepseek-ai/dsh-skill` 与
  `@deepseek-ai/dsh-skill-filesystem` 的 `lib/index.js`（rank 常量、frontmatter 键的合法性校验都在里面），
  或上游源码仓库的 `docs/subsystems/skills.md`。
- 角色卡规范：SillyTavern V2/V3 spec（character-card-spec-v2 / v3）。
