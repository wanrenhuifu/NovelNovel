# AGENTS.md

DeepSeek Harness (dsh) 插件（npm 包 `dsh-novelnovel`）：把小说写成**工作区里的普通文件**，让 harness 的
agent 直接用 `novel_*` 工具写作、导卡、维护设定、检索、导出。**自己不直接调模型**（模型请求都走
harness 提供的能力：正文由当前会话写，`novel_review` 的语义自检走 `ctx.subagents` 委派一个一次性
子 agent），数据落 `<工作目录>/<dataDir>/`。领域逻辑集中在 `src/domain/`。

**两个半边都做**：宿主半边是 Node 侧的工具/技能/命令/系统提示词段 + 4 条 `/api/novel.*` 路由（读 + 写）；
客户端半边是 Web 侧栏的**读写**面板（作品 / 章节 / 正文 / 角色卡 / 目标字数）。客户端半边是 **fail-closed** 的
（`dsh.client` 一旦声明，`exports["./client"]` 指向的产物读不到就让**所有**客户端插件一起加载不出来），
所以两个产物必须同时构建、装之前必须过 `scripts/test-manifest.mjs`、**开发迭代只装专用 profile（`nn`）**。
曾经整体砍掉过客户端半边（理由与恢复清单见「坑」第一条），现在是恢复后的状态。

写作方法由技能承载：8 个技能随包注册（rank 250，含两个入口技能 `novel-plan` / `novel-quick`），
用户自己的方法用 `novel_skill` 导入到项目根的
`.dsh/skills/`（rank 100，会覆盖同名内置技能）——那是唯一落在 `<dataDir>` 之外的写入。

MIT 许可（`LICENSE`）。分发走 `npm pack` 的 tarball（`prepack` 自动构建）；`package.json` 已处于
可发布状态（无 `private`，`files`/元信息齐全），但**尚未发到 npm**——README 里 npm 那段是按
"未发布"写的，真发出去之后要同步改。

## 命令

```bash
npm run build       # esbuild → lib/index.js + lib/client.js（lib/ 不入库；改完 src 必须重建，profile 加载的是产物）
npm run typecheck   # tsc -p .（严格模式，noUnusedLocals/Parameters，零错误才过）
npm test            # 15 个纯逻辑单测（10 个 domain + 5 个客户端）
node scripts/test-card-import.mjs   # 角色卡解析链路（PNG V2 / ccv3 双写 / JSON / V1 / 世界书并入 / 关键词拆分）
node scripts/test-card-export.mjs   # 角色卡导出往返（编辑后再导出不回退、V1 字段不丢、非 PNG 头像占位、魔数嗅探）
node scripts/test-preset-import.mjs # 预设导入解析 + story_string 渲染（含空变量报警与 {{char}}）+ 提示词组装 + 截断
node scripts/test-source-domain.mjs # 资料源拆解与通道分类：真实卡条目名 → 通道判定、计数/拼接、拆卡、两种世界书形状
node scripts/test-review-domain.mjs # 自检与词条治理：硬门槛（字数/格式/重复）+ 子 agent 结论归一化（各种坏形状）+ 注入排序与双上限 + 筛选只准删
node scripts/test-search.mjs        # 章节全文搜索：命中/摘要/标题/上限/顺序/全半角/长度变化的小写折叠
node scripts/test-reorder.mjs       # 章节排序：边界/位移/规范化/不可变性
node scripts/test-skill-pack.mjs    # 技能包解析 + SKILL.md frontmatter 往返 + 项目根祖先链
node scripts/test-domain-utils.mjs  # 字数统计（标点与扩展 B 汉字）+ 词条关键词匹配（全半角、空白键）
node scripts/test-manifest.mjs      # **装机前的闸门**：dsh.client 与 exports["./client"] 产物必须同时成立（两个抛点都拦）
node scripts/test-client-normalize.mjs   # 面板归一化：坏形状不抛错、缺字段给可用兜底
node scripts/test-client-logic.mjs       # 客户端纯逻辑：键盘导航 / 请求地址拼装 / 响应解析
node scripts/test-panel-render.mjs       # jsdom 真渲染整棵面板（不复制面板代码）+ 坏数据不崩
node scripts/test-panel-interaction.mjs  # 真 DOM 挂载 + 真实点击/键盘事件
node scripts/test-client-bundle.mjs      # 产物形态 + 冒烟执行（物化 factory 并调 apply）
npm run test:guard                  # 旧 harness 副本必须被拒绝加载（子进程里造一份假副本，不需要装插件）
npm run test:hygiene                # 测试不许污染用户 profile + **每个装了插件的 profile 都验一遍**（含客户端产物）
npm run test:dsh                    # 68 项端到端检查：真实 harness 服务上驱动全部工具（不调模型）
npm run test:compose                # 真 ClientModuleRegistry 组合：boot graph 含本包 + 能服务产物字节
npm run test:bundle-runs            # 执行交付产物本身（跑 lib/client.js 的 factory 并调 apply）
npm run test:primitives             # **升级 DSH 后的第一道闸**：从安装里的前端产物挖出外壳静态模块表，核对我们的 require 说明符都在表里；再核对 primitives 的导出名（0.2.1 起该包并入前端 bundle，导出名核对降级为"名字出现过"）
npm run test:tokens                 # 面板用的 CSS 变量必须在首方产物里存在
npm run test:routes                 # Web 路由（读+写）：状态码、错误分级、内容级 CAS、同源校验、不泄露绝对路径
npm run test:sandbox                # 真实 sandboxPolicy：伪造 Session 会被拒 + store 必须透传真品
npm run test:chapter-guard          # 真实 fs 语义：章节 id 不能当路径段（越界 id 读不到别的作品）
npm run test:race                   # 并发交错：CAS 真的挡住了吗（用 fs 钩子构造交错，CAS 正确性只能这样证明）
npm run test:edge                   # 边界语义：章节引用优先级 / keys 规范化 / 破坏性操作闸 / 缺失正文的点名
npm run test:contract               # 文档契约：README 工具表承诺的 action 必须真实存在（双向）
npm run test:package                # 分发冒烟：npm pack → 解包 → 加载 → 技能与工具都注册（两个半边都要在）
npm run test:paging                 # 章节列表分页：数 ctx.fs 调用与 summary 长度，证明分页真的省了
npm run test:words                  # 字数缓存：改文件后字数仍重算（README 的承诺）+ 缓存真的省调用
npm run test:lifecycle              # 生命周期：重复挂载会抛错、卸载后干净、能重新挂载
npm run test:prompt                 # 系统提示词段：文本内容 + 组装位置 + 卸载后不留残留
npm run test:skills                 # 自带技能：中文触发词必须在 description 里（whenToUse 不进提示词）
npm run test:perf                   # 性能探针（带 ctx.fs 调用计数）
```

`scripts/bundle-source.mjs` 是纯逻辑单测共用的打包器（把 `src/` 的 TS 打成临时 ESM 再 import 真代码）。
它用 `write: false` + 手工落盘：**esbuild 的子进程在受限环境下写不了工作区外的临时目录**
（报 `Access is denied`，而同一个路径 `node:fs` 写得进去）。别再改回 `outfile:`。

端到端与性能探针统一走 `npm run test:*` 的启动器（`scripts/dsh-node-launcher.mjs`）：它们用
**DSH 自带的 Electron Node** 跑 `tests/verify.mjs` / `tests/perf-probe.mjs`（harness 包在 `app.asar`
里，普通 node 读不到），cwd 是一个**一次性临时目录**并注入 `DSH_ENTRY`/`DSH_INSTALL`/`NN_TEST_CWD`。
**cwd 绝不能是 profile 目录**：曾经是，于是走 `process.cwd()` 的探针把三本空作品写进了用户的
`~/.dsh/profiles/<name>/`；插件与 harness 的解析靠 profile 锚点与安装路径、**不依赖 cwd**，
所以换成临时目录不影响任何解析（`npm run test:hygiene` 守着这条，静态+动态两道）。
安装目录自动探测（`$DSH_INSTALL` → 从 `$DSH_ENTRY` 反推 → `%LOCALAPPDATA%\Programs\*` → 常见位置；
本机的 Electron 用户级安装落在 `D:\Users\qm\AppData\Local\Programs\DeepSeek Harness`，**不在** `D:\DSH`，
所以自动探测那几项少了就会每次都要手动设 `DSH_INSTALL`）；
**测试用哪个 profile 只认 `DSH_TEST_PROFILE`（默认 `nn`）**——
不读会话里的 `DSH_PROFILE`（桌面端会话里它是 `desktop`，插件不一定装在那儿）。
`DSH_TEST_PROFILE` 由 `scripts/verify-*.mjs` 读，再作为 `DSH_PROFILE` 注入子进程；
**`tests/` 里的脚本要读 `DSH_PROFILE`**（那是启动器保证注入的那个）——
`tests/verify-client-compose.mjs` 曾经读 `DSH_TEST_PROFILE` 的字面默认值，默认名一漂移整条测试就空转了。
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
- `src/clientApi.ts` 宿主侧给面板的接口（读 + 写）：`/api/novel.projects` / `novel.project` /
  `novel.chapter`（GET 读 + POST 写，**path 精确匹配**、读写共用一个 path 靠 method 分流）与
  `/api/novel.character`（只有 POST：上传字节导入 / 参与开关 / 删除）。鉴权仍归 connection 的 fence，
  写请求**另加一道同源校验**（`crossOrigin`）。
  存 `NovelStore.workspaces`（cwd → **真 Session 对象**）与 `workspaceOf` / `writeWorkspaceOf`
  也在这个用途上：HTTP 路由没有会话上下文，cwd 只能由前端告知并**按白名单校验**；
  `writeWorkspaceOf` 比读多带一个 `actor`（见「坑」里面板写入记账那条）。
- `src/client/**` 浏览器半边（React）：`index.tsx` 是插件入口（`apply(ctx)` + `inject = ["slots"]`
  + 错误边界）、`panel.tsx` 面板视图、`state.ts` store 与归一化、`normalize.ts` 坏形状兜底、
  `api.ts` 请求拼装/响应解析（读写两套）、`useChapterKeys.ts` 键盘导航、`styles.ts` 面板 CSS、`env.d.ts` 手写类型声明。
  两个插槽：`sidebar.panellist`（图标）与 `main`（面板，`key` 与侧栏 `id` 必须一致——那是两者唯一的联系）。
- `src/tools/<name>.ts` 一个工具一个文件，`src/tools/index.ts` 注册；`src/tools/shared.ts` 放统一输出
  形状（`TEXT_OUTPUT`/`textRender`）、`lines`/`preview`/`requireFields` 与 `ToolDeps`
  （含**软挂载的** `subagents()` 取值器：读的时候才查，拿不到就得明说，不能当成"检查通过"）；
  `src/tools/subagent.ts` 收口"起一个只读的一次性子 agent 并拿结构化结论"（第 4 步的机制层，
  与自检、词条筛选两条用途共用）。
- `src/skills.ts` 枚举 `skills/*/SKILL.md` 并 `ctx.skills.register` 运行时注册（另导出
  `bundledSkillNames` 供 novel_skill 判断同名覆盖）；`src/command.ts` 是 `/novel` 命令
  （把当前作品状态以文本返回，不经过模型）。
- `src/domain/` 纯逻辑，**不 import harness、不碰文件系统**（连 `node:*` 都不引，路径运算自己写）：
  `cardImport.ts`（角色卡解析 + 世界书提取）、`presetImport.ts`、`prompt.ts`（系统提示词组装、宏替换、
  词条注入与**注入治理**：`rankLoreEntries` 的相关度排序 + 条数/字符双上限、续写消息拼装）、
  `sourceImport.ts`（资料源拆解与**通道分类**：把一张现代社区卡拆成 设定/文风/玩法/状态/角色/素材，
  每条带判定理由；含独立世界书的两种 JSON 形状解析）、`review.ts`（自检的硬门槛、子 agent 提示词、结论归一化）、`loreFilter.ts`（候选池筛选的提示词与
  **只准删**的归一化）、`progress.ts`（"已写 / 目标"字数的展示口径，三处共用）、`search.ts` / `reorder.ts`（id 泛化为 `string | number`）、
  `export.ts`（正文拼装 + 角色卡 PNG 再导出）、`png.ts`（chunk 读写 + deflate）、
  `stateUpdate.ts`（状态层：迷你 YAML 初值解析、`<UpdateVariable>` 抠块与剥离、JSON Patch 变体的应用与拒绝口径、树渲染）、`skillFrontmatter.ts`（SKILL.md 解析/渲染，两条投递路径共用）、`skillPack.ts`（技能包解析 +
  项目根祖先链）、`utils.ts`、`types.ts`。
- `tests/verify.mjs` 端到端（68 项）；`tests/harness-loader.mjs` 是测试侧的 harness 解析器
  （锚点顺序、`registerHarnessHook` 见「坑」）；`scripts/dsh-node-launcher.mjs` 负责用 DSH 自带的
  Electron Node 起测试，`scripts/verify-dsh.mjs` / `scripts/probe-dsh-perf.mjs` 是它的两个入口；
  `tests/fixtures/stale-harness.mjs` + `scripts/test-harness-guard.mjs` 是「旧副本必须被拒绝」的用例；
  `samples/preset-example.json` 供测试导入预设用；`scripts/restore-desktop-bundle.ps1` 是装进
  desktop profile 的等待脚本（应用退出后自动入列并核对，见「坑」）。

## 约定

- 模型可见的字符串用**英文**：工具 `description`/参数说明/`summary`，以及 SKILL.md 的 frontmatter
  与正文（`description` 就是模型唯一能看到的路由判据，harness 对工具 schema 和技能都没有本地化
  机制）。中文留给 README、AGENTS.md、代码注释。
  **但技能的 `description` 必须带中文触发词**（`润色`/`断章` 这类）——这条被实测纠正过：
  技能目录的模板（`@deepseek-ai/dsh-tool-skill` 的 catalog template）是
  `` - `<name>`: <normalized-and-capped-description> ``，**只列 `description`，`whenToUse` 不进提示词**
  （后者只出现在 API 控制器的技能列表里，是给面板/外部消费者用的元数据）。
  所以"中文触发词写在 `whenToUse` 里"曾经等于白写：实测把提示词全组装出来后，
  `润色`/`改写`/`去 AI 味`/`断章` **一个都没出现**。现在 8 个技能的 `description` 末尾都带
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
- **客户端半边是 fail-closed 的**（踩过一次：整台机器的前端都打不开）。宿主 `ClientModuleRegistry`
  **构造函数里**会扫每个 loader 行，对声明了 `dsh.client` 的包读 `exports["./client"]` 指向的文件：
  两个抛点 —— `declares dsh.client but exports no "./client" bundle`（清单声明了却没写 exports）
  与 `MissingClientBundleError`（写了 exports 但**文件读不到**，ENOENT）；两者聚合进
  `ClientPackageCompositionError` 后 **同步抛出** → 服务起不来 → `/plugins` 路由与
  `window.__DSH_BOOT__` 注入都不发生 → **所有客户端插件（含首方 UI）都加载不出来**。
  一个包缺产物能拖垮别人的界面，现场看起来像"插件之间冲突"。所以本包用三道闸：
  ① `build.mjs` 两个产物同时成功（任一 throw 整个 build 失败）；
  ② `scripts/test-manifest.mjs` + `tests/verify-package.mjs` + `scripts/test-profile-hygiene.mjs`
     在装机前把上述两个抛点变成红灯（清单、exports 形态、**产物真实存在且非空**、产物形态自证）；
  ③ 开发迭代只装专用 profile（`nn`），不装日常界面。
  产物形态是经典 script `window.__ModuleLoader__.load({id, factory})`（**不是 ESM**），
  `require` 的说明符必须是外壳**静态模块表**的精确键——写错只在**浏览器 console** 报
  `missed the module table`，服务端完全看不到。那份表的唯一来源是
  `scripts/client-platform-modules.mjs`（**别手抄**：`test:primitives` 会从 `dsh-web-frontend/dist/assets/index-*.js` 里锚定我们某个说明符、再按花括号配平切出那张表字面量来比对——压缩后的函数名每个版本都变，`rM()` 只是 0.2.0 那一版的名字；0.2.1 起表里多了 `zod` 与 `@tanstack/react-virtual`，而 `dsh-client-ui-primitives`/`-ui-slots` 已不再是独立 npm 包、被打进前端 bundle，模块表里两个键仍在；
  **升级 DSH 后第一个要复核的就是它**）。清单里 `dsh.client.inject` 列的平台包**不要**写进
  `peerDependencies`：它们由外壳的静态表在浏览器里提供，不走 Node 解析（写进去反而会让 Desktop 的
  `routeLinked` 去应用安装里找它们）。
- **宿主给客户端的接口要 `ctx.inject(["connection"], …)`，不能在 `apply` 里直接 `ctx.get("connection")`**
  （实测踩到，且表现极难归因）：插件行在 loader 里比 Web 那几行**早**，而 `ctx.get` 是**只查一次、
  拿不到就没了**——结果是三条 `/api/novel.*` 路由永远不注册，面板每次取数都 404，
  **而宿主工具一切正常**（`novel_*` 能用、`/novel` 能用），现场看起来像"面板坏了"。
  `ctx.inject` 是软挂载：服务还不存在时把回调排队，等 provide 之后执行。
  同一条形状的坑在 skills / commands / systemPrompt 上已经各踩过一次。
- **`/api/novel.*` 的 cwd 白名单是安全边界，别简化**：HTTP 请求**没有会话上下文**，工作目录只能由
  前端告知；"前端说什么就信什么"等于把任意目录读取开放给任何拿到会话 cookie 的页面。
  所以 `NovelStore.workspaceOf` 只认 `remember()` 记过的「本进程里真会话用过的工作目录」，
  且复用的是**当初那个真 Session 对象**——`ctx.sandboxPolicy.resolve({ session })` 要读会话的
  `snapshotEvents()`，喂 `{ header: { cwd } }` 的伪造体会直接 `TypeError`，三条路由全 500/400
  （`npm run test:sandbox` 守着这条）。白名单为空时回 **403 `unknown_workspace`** 并告诉用户
  "先跑一次 novel_* 工具"，而不是猜一个目录去读。前端把这条 403 翻成可读的中文提示
  （`src/client/state.ts` 的 `describe`）——首次打开看到它是**设计如此**，不是故障。
- **`scripts/restore-desktop-bundle.ps1` 必须存成 UTF-8 带 BOM**：本机只有 Windows PowerShell 5.1
  （装了 pwsh 7 之后 DSH 的执行器才会用它；执行器解析顺序是 `%ProgramFiles%\PowerShell\7\pwsh.exe` →
  PATH → 5.1）。5.1 按 ANSI 解码无 BOM 的脚本，中文注释会让它直接报语法错；用编辑工具改完这个文件
  要重新补 BOM。同理：**绝不能用 `Set-Content -Encoding UTF8` 写 profile 的 `package.json`**
  （5.1 的 UTF8 带 BOM，宿主 `JSON.parse` 会失败），也不能用 `Get-Content` 读含中文的
  `package.json`（无 BOM 的 UTF-8 会被按 ANSI 解码成乱码）——脚本里统一走 .NET。
- **「必须先完全退出应用才能改 desktop profile」这条被实测推翻**（`restore-desktop-bundle.ps1` 的注释
  与 README 旧文都这么说，但没人验过）：实测**应用运行中**对 profile 的 `package.json` 做
  `[System.IO.File]::Open($f,'Open','ReadWrite','None')` **能拿到独占句柄**——应用不持有它的文件锁；
  `dsh plugin --profile desktop remove <pkg>` 也**在应用运行中一次成功**（依赖与 lockfile 都清掉了）。
  所以「等应用退出」不是硬前提，真正需要重启的理由只剩一条：**插件只在启动时装载**。
  三条附带结论（都踩过）：
  - **别拿「进程数归零」当退出判据**：这台机器上应用重启的窗口**短于 2 秒轮询间隔**，
    等进程的脚本会永远等不到那一刻——实测白等 226 秒，那组进程一次都没换过（用户确实退了托盘）。
  - **`--dump-config` 对 desktop 用不了**：`dsh --profile desktop --dump-config` 会被
    `rejectElectronProfile` 拒掉（`profile "desktop" is managed exclusively by the Electron
    application`）——**只有 `plugin` 子命令**（wrapper 内部 `manageDesktopProfile: true`）放行。
    要核对 desktop 的组合树就读 `package.json` 的 `dsh.profile.bundles` 原文，别指望 dump。
  - **`pnpm remove` 不会清理 `link:` 依赖的 junction**（`nodeLinker: hoisted`）：依赖与 lockfile 都干净了，
    `node_modules\<pkg>` 仍指向工作树，得手动删。删它用
    `[System.IO.Directory]::Delete($path, $false)` 并先自检 `LinkType -eq 'Junction'`
    ——**recursive 必须为 false**，目标是整个工作树，`Remove-Item -Recurse` 的行为不值得赌。
- **工具参数名就是 schema 键**：`defineTool` 的 `args` 类型由 `parameters` 推导（`contract.ts` 的
  `InferArgs`），schema 里写 `author_note`/`prev_chapters` 这类 snake_case，代码里就必须同名访问
  ——改 schema 键名不改进代码会直接 tsc 报错（有意的防漂移，别用 `any` 绕）。
- **写文件**：`ctx.fs.writeText` 传 `{kind:'createIfAbsent'}` 命中已存在文件会报 `FS_NOT_OBSERVED`
  （本地后端要求先读后写），所以 `fsx.ts` 先 `stat`：已存在用 `replaceIfVersion`（带 stale 校验），
  不存在用 `createIfAbsent`，写完 `emit('fs/observed')` 并**把触发调用的 exec 作为第三参传入**
  （`FsSession.actor`）——observation policy 只对能解析出 session 的 actor 记录观察
  （`if (owner) this.set(...)`，owner 取自 `actor?.agent?.session`，0.2.1-rc.2 仍然如此），不传就等于
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
- **Lorebook 注入语义**：`domain/prompt.ts` 的 `rankLoreEntries` —— **常驻有两种**：`keys` 为空，或
  ST 的 `constant: true`（**有关键词也常驻**；实测卡里 `constant` 53 条、**作者禁用 22 条**→ 启用 31 条 / 3.36 万字，
  就是"规则 + 生成器 + 常驻世界"那一层；**别把禁用的也算进去**，我第一版数字就是这么报大的）。
  常驻**不占**命中条目的条数/字符预算，并按 `position`（`before_char` 在前）稳定排序。
  命中层默认 24 条 / 24000 字（`maxInjectedLoreEntries` / `maxInjectedLoreChars` 可调，0 = 不限）。
  **匹配上下文包含本章目标与这一轮的指令**（`tools/context.ts` 的 `contextText`）——只看已写正文时，
  第一章（正文为空）永远命中不到任何关键词，整本关键词世界书等于全程静默；实测《道渊》补上指令后
  从 31 条变成 33 条（多出林若悠 / 宫银叶两条人物档案）。
  **浏览**走 `novel_source action=entries`（按通道 / 是否常驻 / 关键词过滤 + 分页；给 `chapter` 时逐条
  回答"为什么进/不进这一章的简报"——它直接调 `rankLoreEntries`，不另写一套匹配，避免两套口径）。
  它浏览的是**世界书**（可注入池），所以 `state`/`material` 通道的条目不会出现在这里，那些用
  `novel_source action=show` 看源实体。
  有 keys 时仅当任一关键词（逗号分隔、**大小写与全半角归一化后**）出现在续写上下文里才注入。
  拆分规则只有 `splitLoreKeys` 一份实现（读取侧与写入侧共用），写入侧由 `normalizeLoreKeys`
  规范化成「逗号 + 空格」——否则 `keys=",,"` 拆完是空数组、会被当成**常驻注入**（每回合全文
  进提示词），而列表显示"有关键词"。改语义时同步更新 `skills/novel-cards/SKILL.md` 与 README。
- **状态层（变量树）的四条口径**（`domain/stateUpdate.ts` + `store` 的 append 路径）：
  ① **先剥块、后应用**：`<UpdateVariable>` 是模型写在正文里的协议，`appendChapterBody` 先把它抠掉再
  写正文，**正文写成功之后**才应用 patch——反过来的话正文写失败会留下"状态变了但正文没落盘"。
  剥块是大小写不敏感、多块按顺序应用。
  ② **status 只认协议**：`delta` 只作用于**已存在的数字**（打在字符串上会被拒并说明），`path` 必须以
  `/` 开头，`_` 开头的字段只读，数组用 `-` 表示追加。刻意放宽的一点：`replace` 命中不存在的路径会
  **创建**（模型经常直接写新键），日志里记为 `created`。被拒的一律进 `rejected`，**绝不静默忽略**。
  ③ **状态与预设无关**：`## 当前状态` 刻意放在 `story_string` 的 if/else **之外**（与全书大纲同一种
  待遇）——模板管"设定怎么呈现"，状态是模型必须维持的事实，不能被一个没引用它的模板吞掉。
  ④ **日志只是给人看的**：`state-log.jsonl` 是 append-only，写失败**不阻断**状态更新（吞异常）；
  `clear` 必须 `confirm=true`。
- **自检的子 agent（`ctx.subagents`）四条实测口径**：DSH 里**没有持久后台 agent**——只有
  `start(provider, request)` → `{ id, result, dispose }` 的一次性 run（`dsh-base` 提供 `spawn` / `fork`），
  `ctx.jobs` 也是进程内的（官方 README：进程死则 job 死）。所以"每章自检"就是每章起一个干净上下文的
  `spawn`，拿到结论即销毁，**别按"常驻 agent"设计**。四个容易记错的点：
  ① `result` **从不 reject**：失败信息在 `stopReason` / `diagnostic` 里，判"有没有结论"要看
  `structured` 在不在（`dsh-subagent-in-process-driver` 的 `readResult`）；
  ② `outputSchema` 是**标准 JSON Schema**（object 根、`required` 是**字符串数组**），provider 会把它
  注册成子 agent 的 `structured_output` 工具参数，形状不合规在 `setup()` 里就抛——所以测试拿 harness
  自己的 `assertObjectJsonSchema` / `validateJsonSchemaValue` 验，而不是自己再写一遍断言；
  ③ 权限收窄用 `toolFilter: { allow: [] }`（"一个全局工具都不留"），**不是**逐个 `deny`：
  `tools.restrict()` **点名不存在的工具会直接抛错**，硬编码清单换个 profile 就能把整条链路弄挂；
  空 `allow` 不会误伤子 agent 自己那层注册的 `structured_output`——限制只作用于**继承来的**工具面，
  `dsh-tools` 的 `view()` 注释里写得很明确（"never what its OWN layer registers"）；
  ④ `parent` 必须是**活的 Agent**（工具里的 `exec.agent`），拿不到就诚实失败，别伪造一个。
  服务本身是**软依赖**：走 `ctx.inject(["subagents"], …)`（同 connection / skills 那条坑），
  没有它时 `novel_review` 降级成只跑本地门槛并**明说"这不是通过"**，绝不静默判合格。
- **自检的计数口径**（`ChapterMeta.review`）：三种结论里只有 `pass` / `fail` 参与计数
  （`fail` +1、`pass` 归零），第三态 **`inconclusive` 既不加也不清零**——没有 subagent 服务、
  子 agent 报错、返回坏形状、或只跑 `local_only`，都属于"没判成"，不是"这一章写坏了"。
  写 `pass` 而其实没做语义检查等于在数据文件里说谎，所以数据里也如实记 `inconclusive`。
  连败到 `maxReviewAttempts` 就**不再建议重写**（报告里 `STOP` 并让模型交给作者）——
  这是 §2.2 的口径：停下来的条件是"正文写不出来"，所以重写必须有次数上限，而"模型自己数"记不住。
- **面板写入的五条口径**（客户端半边从只读改成能写之后新增的，每条都有测试钉着）：
  ① **记账**：HTTP 路由没有 exec，但「先读后写」策略取 owner 的方式是 `actor?.agent?.session`
  （`dsh-fs-observation-policy/lib/index.js:29`），所以 `NovelStore.writeWorkspaceOf` 用白名单里
  **当初那个真 Session 对象**现造一个 `{ agent: { session } }` 当 actor——面板写入因此与工具写入走
  同一条记账路径，模型之后可以直接写、不需要先读一遍。**别**退回"面板是例外"那种口径。
  ② **保存用内容级 CAS**：`ctx.fs` 的版本是不透明对象，要经 HTTP 序列化再送回来不值当；面板把它
  **加载时读到的那份文本**回传，`writeChapterBodyIfUnchanged` 先比对、再用**同一次读**的 basis 写入
  ——两层都成立，冲突时 409、磁盘不动、草稿留在编辑器里。
  ③ **同源校验的两个比较方向都写反过一次**：`site !== "cross-site"` 与 `host === host` 让
  "同源被拒、跨站放行"，正好反过来。现在 `npm run test:routes` 两个方向都有用例——改 `crossOrigin` 前先看那两条。
  ④ **`Origin` 是 Fetch 规范的 forbidden header**：Node 里 `new Request(…, { headers: { origin } })`
  会把它悄悄丢掉（`sec-fetch-site` 反而留得住），所以测"跨源被拒"只能自己造一个像 Request 的对象。
  ⑤ **一个 path 只注册一次**：`connection.fetch.register` 的 `path` 是精确匹配的键，第二次注册会把
  第一次**覆盖**掉（那样 GET 会神秘消失），所以读写在同一条注册里按 method 分流；
  上传分支按 `content-type` 分流（JSON 的卡也要用非 `application/json` 送过去，那才是"传文件字节"）。
- **带参数的斜杠命令在 Web 端要按两次回车**（第一次真浏览器验证就抓到这条）：首方
  `dsh-client-ui-commands/lib/client.js` 的 `matchEnter` 对**声明了 `input`** 的命令返回的是
  **claim**（"认领这个命令、等参数"），不是执行——`if (desc.input !== void 0) return { claim: … }`。
  所以 `/novel` 敲完第一次回车只是把输入框变成 `/novel ` 并显示 `input.hint`，**第二次回车才提交**
  （`/novel` 后打空格再回车等价）。`/novel list` 这种带参写法同样要两次。**别把 `input` 去掉**：
  没有它时 `matchEnter` 对"带空格的写法"直接 `return void 0`（不认领），`/novel list` 会被当成
  一句普通 prompt 送给模型。README 的用法一节写明了这个手势。
  诊断这类问题的手法（可复用）：`.dsh/sessions/<工作区>/<session>/session.v4.jsonl.zstd` 是**逐事件**
  记录，`zlib.zstdDecompressSync`（Node 24）解开就能看出"输入到底有没有到宿主"——本次就是靠它
  一句 `isSeeded:false`（只有创建记录）把范围从"命令注册失败"缩小到"前端吞了输入"，
  再用服务器日志里的注册探针排除掉另一半。
- **现代社区角色卡是「世界模块」，不是「一个人」**（这一条把之前的实现直接证伪了）：
  实测《道渊》v5.4.2（`chara_card_v3`，10.25 MB）：`description` 只有 297 字（封面语）、`first_mes` **18,650 字**
  （整个开篇剧本）、`personality/scenario/system_prompt/post_history_instructions` **全 0**、
  `character_book` **356 条 / 286,833 字**（卡的正文＝设定集）、`extensions` 里 6 段运行时脚本
  （MVU-offline v1.0.2 + Zod schema + **1.03 MB** 悬浮状态栏）与 **21 条正则**。
  所以「导入一张卡 = 建一个角色」是错的：规则、生成器、变量初值全在 `character_book` 与 `extensions` 里。
  现在的口径：`novel_source action=import` **拆解 + 按通道分类**（lore/style/gameplay/state/cast/material），
  可注入通道并进世界书（带 `source`/`channel`），`state`/`material` 只留在源里；分类是启发式、
  **一定会错**，所以每条带 `reason`、将来面板可逐条改。
  实测结果（真卡）：356 条 → 保留 342 条（空条目丢弃）、设定 140 / 角色 188 / 玩法 11 / 状态 2 / 素材 1，
  123 ms 完成；**`[initvar]` 与 `变量列表` 没有被误当词条**。
  两个待跟进：① 规则条目现在也进了世界书（带 `channel=gameplay` / `constant`），注入策略见「Lorebook 注入语义」；
  ② 面板上传上限 `MAX_UPLOAD_BYTES = 8 MB` **会拒掉这张 10.25 MB 的卡**（工具路径没有这个限制）。
'
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
  **装进哪个 profile 有讲究**：只有 `web`/`headless`/`sdk`/`sdk-minimal`/`acp` 这五个**名字**会从自带
  模板自动初始化，其他名字只得到 `dsh-base` 一个 bundle——而 base 只是内核（无 Host、无 HTTP、
  无 runner），没有可交互面。自定名要走启动器的正规出口：
  `dsh --profile <name> --from-default-profile web --dump-config`
  （实现是 `profile-boot` 的 `initializeProfileFromDefault`：校验模板名 → 拒绝自带名 → 独占建目录 →
  复制**模板的组合包列表** → 失败整个回滚；只复制包清单，**不**复制同名 profile 的本地状态）。
  加 `--dump-config` 就是「只创建、不起服务」。本仓库的开发迭代 profile 叫 **`nn`**，
  测试默认也指向它（`DSH_TEST_PROFILE`）。
  **`desktop` 是另一回事**：桌面端应用独占它（`dsh --profile desktop` 启动会被拒），但**插件管理支持**
  ——桌面端自带的 CLI wrapper（`<安装>\resources\runtime\cli\bin\dsh.cmd`，内部以
  `manageDesktopProfile: true` 调 `runCli`）允许 `dsh plugin --profile desktop add|remove`。
  **不需要先退出应用**（实测：应用运行中 `dsh plugin --profile desktop remove` 一次成功，
  profile 的 `package.json` 也没有被应用锁住——详见「坑」里那条纠正）。别照旧文档说「会被拒」，
  也别照旧文档说「必须先退出」。
  **本机 `dsh` 与 `pnpm` 都不在 PATH 上**，一律走那个 wrapper。
  **装完必须重开才生效**：客户端注册表只在启动时构建一次（之后是 `internal/plugin` 增量扫描），
  所以"装完不重开"的表现是**宿主工具正常、侧栏没有面板、console 无报错**——
  这个形态实测踩过一次（应用 16:49 启动、插件 17:12 装进 profile）。
  `link:` 装法下**重建产物即生效**，所以别把开发中的插件装进日常 profile。
  插件的观测口径（工具、技能、命令）都以 `npm run test:dsh` 为准；
  「面板真的注册上了」要用 `npm run test:compose`（真注册表组合）或对运行中的 server
  取 `index.html` 里的 `globalThis["__DSH_BOOT__"]` 看本包那一行——**不要只看截图**。

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
- **面板还没做的**：项目设定（简介 / 世界观 / 写作要求 / 大纲 / 标题）没有面板入口——目前只有
  **全书目标字数**能改；角色卡头像只显示"有 / 没有"，不渲染图片；lorebook（词条）没有面板；
  面板**不自动刷新**（模型写完不会跳提示，点「刷新」或重开面板；`connection/reset` 会重取）。
  这几条 README 的「还没做（面板侧）」里有对应说明，改到附近时顺手评估。
- **从未跑过真实模型会话**：全部验证都在工具层，不调模型——技能路由、简报实际 token 量、
  模型会不会滥用 `action=write` 都还没有证据。**自检那条链路只证到了插件这一半**：
  `npm run test:dsh` 用一个假 `subagents` 服务验"我们传出去什么、拿回来怎么处理"，
  再用 harness 真的 `assertObjectJsonSchema` / `validateJsonSchemaValue` 验 schema；
  子 agent **自己**判得准不准、会不会在该停的时候停、`allow: []` 在真实子会话里有没有副作用，
  都还没有证据（`docs/design/auto-writer.md` §9 列的假设仍然成立，只是又划掉了两条）。
- **自动写作还差第 8、9 步**：跨章记忆目前只有"近章尾部原文"（Push）——**没有检索**（Pull）。
  三个候选（新增 `novel_recall` / 强化 `novel_chapter action=search` / 暂不做）仍未定，
  所以模型想找第 3 章埋的伏笔时只能自己 `action=search` 或 `read`。
  公开分发形态（npm 发布 + `dsh.compatibility`）也没做——注意 `dsh.compatibility` 这个字段
  **在 DSH 里并不存在**（实测全 asar 零命中），真机制是 `peerDependencies` 的版本区间 +
  profile 的 `compatibility.json` 例外表，本包现在全是 `"*"`，`0.2.1-rc.2` 下已通过（`0.2.0-rc.2` 也验过）。
- **面板已在真浏览器里跑通（`nn` + `dsh web`），但还没在 `desktop` profile 里过一遍**：
  实测流程（可复用）：`dsh --profile nn --host 127.0.0.1 --port <p> --no-open`（它会打印**带 token 的 URL**，
  不带 token 访问只会拿到 401）→ 在会话里跑一次 `novel_*` 工具或 `/novel` 预热工作目录 →
  侧栏出现 NovelNovel 图标，点开有数据（本次用的是演示工作区：3 章 + 4 张卡 + 3 条词条）。
  服务端那一半**不带浏览器也能核**：`GET /` 里 `globalThis["__DSH_BOOT__"]` 的本包那一行有 `url` 与 `rev`
  （宿主自己算好的，**别照 `dsh-novel` 那个探针自己算**——算法对不上），取那个 url 应返回
  `window.__ModuleLoader__.load({ id: "dsh-novelnovel", … })`，且与 `lib/client.js` **逐字节一致**
  （只多一行宿主的 `sourceMappingURL`）；`dsh --profile nn --dump-config` 可核宿主半边在组合里
  （`# == dsh-novelnovel`）。这几条以后每次改客户端半边都值得重跑一遍。
  **剩下没做的**：`desktop` profile（装进去 → 完全重启应用 → 侧栏出现，`scripts/restore-desktop-bundle.ps1`
  就是为它写的），以及真机观感——比如行内按钮是"悬停/选中才出现"，触屏上的手感没验过。

## 参考

- `README.md`：安装（含桌面端）、工具表、配置、数据布局、设计说明。
- dsh 插件开发文档：`docs/user/develop/**` 与 `docs/subsystems/*.md` 只存在于上游源码仓库
  （github.com/deepseek-ai/deepseek-harness），**本机安装里没有**——安装目录
  （本机是 `D:\Users\qm\AppData\Local\Programs\DeepSeek Harness`）内只有 `resources/app.asar`
  与 `resources/app.asar.unpacked`，asar 里只有 `lib/` 与 `node_modules/`，既没有 `docs/` 也没有
  `src/`、`apps/`、`packages/`。读 asar 内容要么用 DSH 自带的 Electron Node（`ELECTRON_RUN_AS_NODE=1`），
  要么自己解析 asar 头（8 字节 pickle 前缀 + JSON 头；第二层的字符串长度在偏移 4、JSON 从偏移 8 开始）。
  真实 API 以 asar 内 `@deepseek-ai/*/lib/*.js` 与 `lib/types/*.d.ts`，以及桌面端 CLI 的
  `--dump-config` 为准（`dsh --profile desktop` 会被拒，但 `dsh plugin --profile desktop ...` 可以）。
- 技能子系统（rank 表、frontmatter 键、注册与覆盖语义）：看安装内 `@deepseek-ai/dsh-skill` 与
  `@deepseek-ai/dsh-skill-filesystem` 的 `lib/index.js`（rank 常量、frontmatter 键的合法性校验都在里面），
  或上游源码仓库的 `docs/subsystems/skills.md`。
- 角色卡规范：SillyTavern V2/V3 spec（character-card-spec-v2 / v3）。
