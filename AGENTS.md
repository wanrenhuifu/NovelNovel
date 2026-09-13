# AGENTS.md

DeepSeek Harness (dsh) 插件（npm 包 `dsh-novelnovel`）：把小说写成**工作区里的普通文件**，让 harness 的
agent 直接用 `novel_*` 工具写作、导卡、维护设定、检索、导出。纯 Node 包——没有 UI、不发模型请求
（模型由 harness 提供），数据落 `<工作目录>/<dataDir>/`。领域逻辑集中在 `src/domain/`。

## 命令

```bash
npm run build       # esbuild → lib/index.js（lib/ 不入库；改完 src 必须重建，profile 加载的是产物）
npm run typecheck   # tsc -p .（严格模式，noUnusedLocals/Parameters，零错误才过）
npm test            # 4 个纯逻辑单测（下面 4 个脚本）
node scripts/test-card-import.mjs   # 角色卡解析链路（PNG V2 / ccv3 双写 / JSON / V1 / 世界书并入）
node scripts/test-preset-import.mjs # 预设导入解析 + story_string 渲染 + 提示词组装 + 截断
node scripts/test-search.mjs        # 章节全文搜索：命中/摘要/标题/上限/顺序
node scripts/test-reorder.mjs       # 章节排序：边界/位移/规范化/不可变性
npm run test:dsh                    # 35 项端到端检查：真实 harness 服务上驱动全部工具（不调模型）
node tests/perf-probe.mjs           # 性能探针（在 profile 目录里跑，带 ctx.fs 调用计数）
```

端到端验证统一走 `npm run test:dsh`：它把 cwd 切到 profile 目录再跑 `tests/verify.mjs`
（`@deepseek-ai/*` 由 profile 的 node_modules 提供），profile 名可用 `DSH_PROFILE` 覆盖。
无 lint 配置。仓库是 git 仓库（origin = `wanrenhuifu/NovelNovel`），提交信息沿用
`feat: 中文摘要（、分隔）` + `- 主题：说明` 列表体。

## 架构边界

- `src/index.ts` 插件入口：`name` / `inject`（硬依赖 `tools`+`fs`）/ `resolveConfig` / `apply`
  —— 注册工具、`ctx.inject` 软挂载技能、命令与系统提示词段（order 4500）。
- `src/contract.ts` 手写的 harness API 最小类型契约（**只有类型、没有运行时**）；运行时真品由
  `src/harness.ts` 解析（`src/harness.ts` 的解析顺序见「坑」）。
- `src/store.ts` 工作区文件存储（作品/章节/词条/角色卡/预设）+ `NovelStore` 的 patch 具名类型；
  `src/fsx.ts` 封装 `ctx.fs`（解析/读写/目录/删除/二进制）与会话构造；`src/types.ts` 落盘结构。
- `src/tools/<name>.ts` 一个工具一个文件，`src/tools/index.ts` 注册；`src/tools/shared.ts` 放统一输出
  形状（`TEXT_OUTPUT`/`textRender`）、`lines`/`preview`/`requireFields`。
- `src/skills.ts` 枚举 `skills/*/SKILL.md` 并 `ctx.skills.register` 运行时注册；`src/command.ts`
  是 `/novel` 命令（把当前作品状态以文本返回，不经过模型）。
- `src/domain/` 纯逻辑，**不 import harness、不碰文件系统**：`cardImport.ts`（角色卡解析 +
  世界书提取）、`presetImport.ts`、`prompt.ts`（系统提示词组装、宏替换、词条注入、续写消息拼装）、
  `search.ts` / `reorder.ts`（id 泛化为 `string | number`）、`export.ts`（正文拼装 + 角色卡 PNG 再导出）、
  `png.ts`（chunk 读写 + deflate）、`utils.ts`、`types.ts`。
- `tests/verify.mjs` 端到端；`scripts/verify-dsh.mjs` 是它的启动器（切 cwd 到 profile）；
  `samples/preset-example.json` 供测试导入预设用。

## 约定

- 工具 `description` 与参数说明用**英文**（harness 没有工具 schema 的本地化机制）；技能正文、
  README、代码注释用中文。只读类工具声明 `isConcurrencySafe`，会写文件的不要声明。
- 危险操作（删作品/章节/角色卡）必须 `confirm=true` 才执行，错误信息提示先问用户。
- `update*` 的 patch 用 `store.ts` 导出的具名类型，不写 `Record<string, …>`。
- 新增工具：`src/tools/<name>.ts` + 在 `src/tools/index.ts` 注册；模型可见的字符串
  （description/parameters/summary）改动要同步 README 的工具表。
- 注释只写约束性说明，不复述代码。

## 坑（改相关代码前必读）

- **harness 依赖**：`@deepseek-ai/*` 声明为 peer + esbuild `external`，**绝不能内联**——服务按模块
  实例注册，产物里第二份会重复注册。以 `link:` 方式安装时包在工作区之外，Node 从包 realpath 找不到
  harness 的依赖闭包，所以 `src/harness.ts` 按「普通 import → harness 进程入口 `process.argv[1]` →
  `$DSH_HOME/profiles` 与 cwd」依次解析，命中即用，保证与运行中的 harness 是同一模块实例。
  `@lenml/char-card-reader` 是 AGPL，只做 external + `dependencies`，不打进产物。
- **工具参数名就是 schema 键**：`defineTool` 的 `args` 类型由 `parameters` 推导（`contract.ts` 的
  `InferArgs`），schema 里写 `author_note`/`prev_chapters` 这类 snake_case，代码里就必须同名访问
  ——改 schema 键名不改进代码会直接 tsc 报错（有意的防漂移，别用 `any` 绕）。
- **写文件**：`ctx.fs.writeText` 传 `{kind:'createIfAbsent'}` 命中已存在文件会报 `FS_NOT_OBSERVED`
  （本地后端要求先读后写），所以 `fsx.ts` 先 `stat`：已存在用 `replaceIfVersion`（带 stale 校验），
  不存在用 `createIfAbsent`，写完 `emit('fs/observed')` 并**把触发调用的 exec 作为第三参传入**
  （`FsSession.actor`）——observation policy 只对能解析出 session 的 actor 记录观察
  （`if (owner) this.set(...)`），不传就等于这些写入对「先读后写」策略不存在，首方 `write`/`edit`
  之后会被要求先读一遍。`ctx.fs` 没有删除与二进制写入能力，删文件/写头像图片是 `node:fs` +
  `ctx.fs.processPath`——这条路径**不受沙箱约束**，因此 `assertInsideWorkspace` 用 `ctx.fs.contains`
  限定只能落在会话工作目录内（别删掉这个检查，`novel_character action=export out_path=` 是
  agent 可控参数）。
- **`ctx.waterfall` 的末参是 fallback**：`ctx.waterfall(event, ...args, fallback)`——不给 fallback 时，
  最后一个业务参数会被当成 fallback 吞掉（表现为监听器收到的 `actor` 是 undefined，极易误判成
  "策略不记录"）。测试里要写成 `ctx.waterfall('fs/write-intent', target, exec, () => undefined)`。
- **损坏数据文件的处理分级**：`project.json` 读不出来 → 跳过该作品目录并在 `novel_project action=list`
  里点名；`workspace.json` 读不出来 → 不致命，但多作品时解析「当前作品」必须显式传 `project=`
  （宁可报错也不猜，避免写错作品）；`chapters/index.json` 读不出来 → 直接报错（静默当空索引会让
  下次建章覆盖整份目录）。数据文件是给人手改的，`readJson` 容忍 BOM/CRLF。
- **技能注册**：不用 `skill-filesystem` 的 `customSkillDirs`——那是 `dsh-base` 的行 config，覆盖它要
  重述整份 config（patch 是整行替换），随上游变化即失效；改走 `ctx.skills.register`（rank 250，
  项目级技能 rank 100/200 仍可覆盖同名插件技能）。SKILL.md 里 `disable-model-invocation` /
  `user-invocable` 是正规键，`modelInvocable` 这类旧键会被 harness 直接拒绝。
- **`slice(-0)` 陷阱**：`recent_chars`/`prev_chars` 为 0 时要显式判 `> 0` 再 `slice(-n)`，
  否则 `slice(-0)` 等于 `slice(0)`，会取到整章（`tools/context.ts` 与 `store.previousExcerpts` 各一处）。
- **解析作品与统计字数分开**：`resolveProjectId` 走 `listProjectRefs`（每个作品只读 `project.json` +
  `chapters/index.json`），读遍全书算字数的 `listProjects` 只服务 `novel_project action=list` 与
  `/novel list`；`previousExcerpts` 先用 `listChapterMetas` 定位再按需读正文。别把正文读回解析路径
  ——实测一次 `action=append` 的 `ctx.fs` 调用会从 39 涨到 1839（409ms→47ms）；`tests/perf-probe.mjs`
  可复测（带调用计数）。
- **预设与文件名的不变量**：同名预设重导入必须**沿用原 id**（否则 `activePresetId` 悬空 → 简报静默
  退回内置默认提示词，而列表仍显示有激活项）；章节正文按 `<chapterId>.md`、角色卡按 `<id>.json` +
  头像按真实媒体类型的扩展名存放；id 一旦生成不再改名（`ctx.fs` 没有 rename，重命名会牵动全部引用）。
- **角色卡**：`@lenml/char-card-reader` 把 V1 卡的 `spec` 标为 `"unknown"`；`cardImport.ts` 的
  `specToVersion` 把非 v2/v3 归为 v1，别"修复"它。头像一律以字节表达（PNG 卡取原文件字节，JSON 卡把
  `get_avatar()` 的 data URL 解成字节），落盘扩展名按媒体类型。`rawData` 必须无损保留原始 JSON。
  入口是 `parseCharacterBytes`（字节 + 文件名 + 媒体类型），没有 File/Blob 版本。
- **世界书导入**：`cardImport.ts` 的 `extractLorebookEntries` 把 character_book 词条并入项目
  lorebook。`{{char}}`/`{{user}}` 宏**在导入时**就按来源卡名/“主角”替换（`replaceMacros`）——项目
  lorebook 混合多卡来源，留到组装时已无法确定 `{{char}}` 指向谁；关键词 `keys` 保持原文不替换
  （要用于上下文匹配）。词条名优先 `entry_name`→`name`→`comment`→首个关键词；空内容条目直接丢弃；
  `enabled` 缺失视为启用。词条 id 由 store 生成后并入项目 lorebook。
- **角色卡 PNG 再导出**：`domain/export.ts` 把任意来源的卡统一转 V2 结构写 `chara` chunk，有 V3
  rawData 时另写 `ccv3`（读取端 ccv3 优先）；头像非 PNG（或缺失）时用纯色占位图。TS 5.8 下传给
  Blob 的必须是 `Uint8Array<ArrayBuffer>`。
- **Lorebook 注入语义**：`domain/prompt.ts` 的 `selectLoreEntries` —— 词条 keys 为空 = 常驻注入；
  有 keys 时仅当任一关键词（逗号分隔、小写比较）出现在续写上下文里才注入。改语义时同步更新
  `skills/novel-cards/SKILL.md` 与 README 的说明。
- **写作预设**：`presetImport.ts` 按字段特征识别裸预设（`content`→system、`story_string`→context、
  `input_sequence`→instruct），含 `context`/`sysprompt`/`instruct` 子对象则当合订信封；reasoning 直接
  拒绝。**instruct 只存档不参与提示词**（对话格式由 harness 的消息结构承担）。`buildSystemPrompt`
  里：`systemPrompt` 替换开场白（过 `replaceMacros`），`storyString` 走 `renderStoryString`
  （仅支持 `{{#if}}/{{else}}/{{trim}}/{{var}}` 子集）替换默认设定区块；`story_string` 的 `system`
  变量映射本项目"写作要求"，lorebook 统一放 `wiBefore`。
- **安装与调试**：改完 `src/` 必须 `npm run build`（`lib/` 不入库，profile 加载的是产物）；
  `link:` 安装后改动只需重建 + 重开 dsh 会话，tarball 安装则要重新 `npm pack` + `dsh plugin add`。
  插件的观测口径（工具、技能、命令）都以 `npm run test:dsh` 为准。

## 参考

- `README.md`：安装、工具表、配置、数据布局、设计说明。
- dsh 插件开发文档（本机源码 checkout）：`/d/DSH/deepseek-harness/docs/user/develop/**`；
  真实 API 以 `packages/**/src` 与 profile 里的 `@deepseek-ai/*` 为准。
- 角色卡规范：SillyTavern V2/V3 spec（character-card-spec-v2 / v3）。
