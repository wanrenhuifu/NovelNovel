# AGENTS.md

AI 小说写作 IDE（纯前端 Web 应用，无后端；可选本地 CORS 代理见下）。数据全部存浏览器 IndexedDB（Dexie），API Key 也存本地。UI 文案为简体中文，暗色暖调主题。

## 命令

```bash
npm run dev                        # 开发 http://localhost:5173
npm run build                      # tsc -b + vite build（严格模式，零错误才过）
npm run proxy                      # 可选：本地 CORS 代理 127.0.0.1:8788
npm run test                       # 全部纯逻辑单测（下面 7 个脚本）
node scripts/test-card-import.mjs  # 角色卡解析链路测试（PNG V2 / ccv3 双写 / JSON / V1）
node scripts/test-iteration.mjs    # 代理转发/安全校验 + PNG 导出回读测试
node scripts/test-preset-import.mjs # 预设导入解析 + story_string 渲染 + 提示词组装 + 续写前文/对话轮数截断测试
node scripts/test-ai-retry.mjs     # AI 请求重试：退避/Retry-After/状态码 + 真实 HTTP 集成
node scripts/test-search.mjs       # 章节全文搜索：命中/摘要/标题/上限/顺序
node scripts/test-reorder.mjs      # 章节拖拽排序：边界/位移/规范化/不可变性
node scripts/test-crypto.mjs       # API Key 加密：enc/dec 往返/错密码/IV 随机/hash 一致性
npm run test:e2e                   # Playwright E2E（先 npm run build；9 条用例，见 e2e/）
```

**Playwright 版本注意**：`@playwright/test` 固定 1.60.0——它与本机已下载的 chromium 1223 对应。
升版到 1.61+ 会要求 chromium 1228+，需重新 `npx playwright install chromium`（本环境下载常超时）。
E2E 的 mock AI 上游在 `e2e/mock-upstream.mjs`（带 CORS 头，端口 8791，浏览器可直连；
`scripts/mock-sse.mjs` 是**无** CORS 头的变体，只用于代理回退测试）。

无 lint 配置；无 git 仓库。

## 技术栈

Vite + React 18 + TS（strict、noUnusedLocals/Parameters、verbatimModuleSyntax）· Zustand · Dexie · CodeMirror 6 · Tailwind CSS **v4**（CSS-first，经 `@tailwindcss/vite`，无 tailwind.config）· lucide-react · `@lenml/char-card-reader`。

## 架构边界

- `src/lib/` 纯逻辑，不依赖 React：`db.ts`（Dexie schema 与设置读写）、`cardImport.ts`（角色卡解析）、`presetImport.ts`（SillyTavern 预设 JSON 解析：system/context/instruct 裸预设 + 合订信封）、`prompt.ts`（system prompt 组装、`{{char}}`/`{{user}}` 宏替换、lorebook 词条按关键词注入、story_string 渲染、续写消息拼装、`trimChatHistory` 对话轮数截断）、`search.ts`（章节全文搜索，返回高亮 segments 与正文位置）、`reorder.ts`（章节拖拽排序纯函数：输出新顺序数组并归一化 sortOrder 为 0..n-1）、`crypto.ts`（API Key AES-GCM 加密/解密、PBKDF2 派生与主密码 hash）、`export.ts`（全书 md/txt 导出、角色卡 PNG 再导出、`downloadBlob` 下载工具）、`backup.ts`（全量 JSON 备份导出/导入覆盖）、`png.ts`（纯浏览器 PNG chunk 读写 + CompressionStream deflate）、`ai/`（`index.ts` 按 provider.type 分发；`openai.ts`/`anthropic.ts` 各自实现流式；`sse.ts` 手工解析 SSE，不引 SDK；`proxy.ts` 直连失败自动回退本地代理；`retry.ts` 出字前失败自动重试的判定/退避）。
- `e2e/`：Playwright 测试（`playwright.config.ts` 同时拉起 vite preview 与带 CORS 的 mock 上游 `e2e/mock-upstream.mjs`：8791 端口，SSE 流里回显 `[lore:on]`/`[continue:rebuilt]` 等标记供断言；`helpers.ts` 提供建项目/建章节/输入正文/等落库等公共步骤）。
- `proxy/proxy-core.mjs` + `scripts/proxy.mjs`：Node http CORS 代理（与浏览器代码隔离，不进 Vite 构建）。`scripts/mock-sse.mjs` 是无 CORS 头的模拟 OpenAI 上游，配合测试代理回退链路。
- `src/stores/` Zustand：所有 IndexedDB 写操作走 store（project/characters/settings），组件不直接调 Dexie（`lib/db.ts` 的 getSettings/saveSettings 除外）。
- `src/components/<feature>/` 按功能分目录；编辑器通过 `forwardRef` 暴露 `EditorHandle`（insertAtEnd/replaceSelection/getContent），供 AI 面板插入生成结果。
- 新增数据类型放 `src/types.ts`，Dexie 升级要在 `db.ts` 加 version（v2 给旧项目补 `lorebook: []`；v3 加 `chatSessions` 表，projectId 为主键）。给 `AppSettings` 加新字段**不需要**加 Dexie version——`getSettings` 会用 `defaultSettings` 兜底补齐旧记录缺失的键（如 `presets`/`activePresetId`）。

## 约定

- 主题色只用 `src/index.css` `@theme` 里的 token：`ink-950…100`、`paper`、`accent-400/500/600`。**不要**用未定义的色阶（如 `ink-500`）——Tailwind v4 不生成不存在的 token。状态色可少量用 red/emerald/amber 默认调色板（amber 用于重试等等待态提示）。
- lucide-react 图标必须真实存在（曾因 `CloudCheck` 不存在换过 `Check`），不确定就查 node_modules。
- 弹窗一律内联 modal（`components/*/...Modal.tsx`），**禁用 `window.prompt/confirm/alert`**。
- 代码注释用中文，只写约束性说明。

## 坑（改相关代码前必读）

- **角色卡**：`@lenml/char-card-reader` 把 V1 卡的 `spec` 标为 `"unknown"`；`cardImport.ts` 的 `specToVersion` 把非 v2/v3 归为 v1，别"修复"它。PNG 导入时 avatar 直接存上传的 Blob；JSON 导入时从 `get_avatar()` data URL 转 Blob。`rawData` 字段必须无损保留原始 JSON。
- **世界书导入**：`cardImport.ts` 的 `extractLorebookEntries` 把 character_book 词条并入项目 lorebook。`{{char}}`/`{{user}}` 宏**在导入时**就按来源卡名/“主角”替换（`replaceMacros`）——项目 lorebook 混合多卡来源，留到组装时已无法确定 `{{char}}` 指向谁；关键词 `keys` 保持原文不替换（要用于上下文匹配）。词条名优先 `entry_name`→`name`→`comment`→首个关键词；空内容条目直接丢弃；`enabled` 缺失视为启用。`parseCharacterFile` 返回 `{character, loreEntries}`，词条 id 由 `stores/characters.ts` 生成，最终由 CharactersPanel 经 `updateProject` 并入——别在 characters store 里直接写 projects 表。
- **PNG 再导出**：`export.ts` 把任意来源的卡统一转 V2 结构写 `chara` chunk，有 V3 rawData 时另写 `ccv3`（读取端 ccv3 优先）。头像非 PNG 时用纯色占位 PNG。TS 5.8 下传给 Blob 的必须是 `Uint8Array<ArrayBuffer>`，不能用 `ArrayBufferLike`。
- **Lorebook 注入**：`prompt.ts` 的 `lorebookBlock` —— 词条 keys 为空=常驻注入；有 keys 时仅当任一关键词（逗号分隔、小写比较）出现在续写上下文里才注入。改注入语义时同步更新 LorebookModal 的说明文案。
- **写作预设**：`presetImport.ts` 按字段特征识别裸预设（`content`→system、`story_string`→context、`input_sequence`→instruct），含 `context`/`sysprompt`/`instruct` 子对象则当合订信封。**instruct 只存档不参与提示词**（对话格式由 API 消息结构承担）；reasoning 直接拒绝。预设存 `AppSettings.presets`，激活项 `activePresetId`。`buildSystemPrompt` 里：`systemPrompt` 替换开场白（过 `replaceMacros`），`storyString` 走 `renderStoryString`（仅支持 `{{#if}}/{{else}}/{{trim}}/{{var}}` 子集）替换默认设定区块；`story_string` 的 `system` 变量映射本项目"写作要求"，lorebook 统一放 `wiBefore`。改这些映射时同步更新 SettingsModal 的说明文案。
- **CORS 代理回退**：`ai/proxy.ts` 的 `fetchWithProxyFallback` 先直连，直连抛 TypeError（CORS/网络）才走 `http://localhost:8788/proxy`；AbortError 要直接抛出不回退。代理端校验目标 URL 必须是 http/https。拉模型列表（GET）不走代理。
- **聊天面板**：续写消息不落正文——`ChatPanel.tsx` 的 `CONTINUE_SENTINEL` 标记此类消息，组装 API 请求时才用最新编辑器正文重建（重新生成也因此始终基于最新正文）。会话存 `chatSessions` 表，发送后与流结束后各落库一次，流式中不逐 token 写库。`abortRef` 类型是 `{abort}` 而非 `AbortController`，保持可替换。
- **会话管理**：`ChatPanel.tsx` 组装请求时用 `prompt.ts` 的 `trimChatHistory` 按 `chatContextTurns`（0=全部）截断——**只截断发给 API 的历史，界面与落库保留完整会话**，从 user 消息处切保证一问一答配对完整（重新生成的多条连续 assistant 也按 user 计轮）。清空会话按钮两步确认（`confirmClear`，onBlur 复位），确认后 `db.chatSessions.delete(projectId)`。回复的"复制"走 `navigator.clipboard`，`copiedId` 短暂高亮 1.5s。`chatContextTurns` 是 AppSettings 新字段，走 defaultSettings 兜底，不加 Dexie version。
- **全书总字数**：`ChapterTree.tsx` 底部 `totalWords` 用 `useMemo` 对 store 的 chapters 逐章 `countWords` 求和——依赖 `saveChapterContent` 同步刷新 store（见下），否则统计滞后。
- **章节拖拽排序**：`reorder.ts` 的 `computeReorder` 接收章节数组 + dragId/targetId + "before"/"after"，返回新顺序数组并把所有 sortOrder 归一化为 `0..n-1`（避免长期拖拽后 sortOrder 数值稀疏或冲突）。返回 null 表示无操作（id 缺失或 dragId === targetId），store 的 `reorderChapters` 拿到 null 直接 return。`ChapterTree` 用 HTML5 原生拖拽：`dataTransfer.setData` 必须有值 Firefox 才触发 drop；`dragover` 必须 `preventDefault` 才允许 drop；`dropEffect = "move"` 让光标显示移动图标。视觉反馈用 `data-chapter-id` + `querySelector` 查行元素，**不要用 callback ref Map**（每次渲染重建函数会让 Map 反复清空重填，拖拽中途取不到元素）。`dragId` 同时存在 state（驱动渲染 opacity-40）和 ref（事件处理器同步读取，避免 React 异步 setState 导致首次 dragover 读到旧值 null）。`dropTarget` 用函数式 `setState` 比较当前值避免多余渲染。`onDragLeave` 要判断 `relatedTarget` 是否仍在行内，否则子元素冒泡的 leave 会过早清掉落点指示条。指示条用 absolute + `-top-0.5`/`-bottom-0.5` + `pointer-events-none`，避免吃掉 drag 事件。↑/↓ 键盘按钮保留——拖拽对触屏/键盘用户不可用。
- **全文搜索跳转**：`search.ts` 的 `searchChapters` 返回的 `pos` 是正文中的字符位置（标题命中为 null）。`App.tsx` 的 `jumpToChapter` 切章节后**轮询等编辑器内容与 store 一致再 revealPos**——Editor 以 chapterId 为 key 重建，立刻调用会落到旧 view 上；判断条件不能用 `getContent() != null`（永远返回字符串）。`EditorHandle.revealPos` 会 clamp 到文档长度并 focus，搜索跳转后编辑器获得焦点是预期行为。SearchModal 里 Enter/↑↓ 走 input 的 onKeyDown，选中项用 `data-idx` + scrollIntoView 跟随。
- **代码分割**：`vite.config.ts` 的 `manualChunks` 把 `@codemirror`/`@lezer` 拆成 codemirror chunk、react/react-dom/scheduler 拆成 react chunk（**判断顺序有讲究**：react-dom 要在 `node_modules/react/` 之前匹配）。`React.lazy` 懒加载：EditorPane、CharactersPanel（App.tsx，Suspense fallback 用 PaneFallback）、SettingsModal（App.tsx，fallback null）、BackupModal/SearchModal（TopBar.tsx，fallback null）。效果：主 chunk 859KB→178KB，首屏关键路径只剩 index+react。**加新的大依赖时先看它落在哪个 chunk**；给已有组件加重依赖不用动分割配置。懒加载组件保持具名导出，lazy 处用 `.then(m => ({default: m.Xxx}))` 包装。
- **快速指令模板**：模板存 `AppSettings.instructionTemplates`（defaultSettings 兜底内置润色/扩写/总结，**不加 Dexie version**——但注意 `getSettings` 的兜底是整键补齐，旧记录若已有该键为 `[]` 不会回填默认模板）。ChatPanel 的 `applyTemplate`：无 `{{selection}}` 直接发送；有宏且有选区则替换后发送；有宏无选区**只填输入框不发送**并提示。ChatPanel 渲染 chips 用 `settings.instructionTemplates`（经 defaultSettings 兜底后必有值，但保留 `?.` 防御）。
- **续写上下文**：`ChatPanel.tsx` 的 `prevExcerpts()` 从 project store 的 `chapters`（已按 sortOrder 排序）取当前章节之前 `prevChapterCount` 章的尾部（每章 `prevChapterChars` 字），与当前章编辑器实时正文一起组装。前文**也参与 lorebook 关键词匹配**（`contextText` = 前文摘录 + 当前章尾部）。`buildContinueUserMessage` 的**空参输出是 CONTINUE_SENTINEL，措辞不能改**——ChatPanel 靠它识别续写消息并在发请求时重建。前文数据取的是 store 里的章节内容（编辑中的当前章用 `getEditorContent()` 实时取，前文章节不在编辑中，无此问题）。`prevChapterCount`/`prevChapterChars` 是 AppSettings 新字段，走 defaultSettings 兜底，不加 Dexie version。
- **自动续写**：ChatPanel 的 `toggleAutoContinue` 开启后，**只在上一轮成功完成时**（`run()` 里 `success` 标志，无错误 + 非用户中断）排下一轮；出错或中断会 `stopAutoContinue()` 停循环。定时器用 ref 存（`autoRunTimerRef`/`autoCountdownTimerRef`），清理函数 `clearAutoTimers` 同时清两个；`autoActiveRef` 是 ref 镜像，因为 `finally` 里读 state 是旧值。切项目/章节的 effect 清理里也会停自动续写（上下文已变）。手动发送/重新生成/清空/停止都会打断循环。间隔 `autoContinueIntervalMs` 走 defaultSettings 兜底（默认 5000ms）。
- **API Key 加密**：`crypto.ts` 的 `encryptApiKey` 输出 `enc:v1:salt:iv:ct` 前缀串，`looksEncrypted` 据此识别；密钥由主密码经 PBKDF2（250k 迭代）派生，主密码本身**不落库**，只存 `masterHash`（PBKDF2 输出，固定 salt 校验用）。`stores/settings.ts` 的 `sessionPassword` 是模块级变量（刷新即失）：非空时 `upsertProvider`/`update` 等写路径统一 `encryptAllKeys` 加密后落库，`load()` 检测到加密 key 且无密码时置 `locked`（App.tsx 据此弹 UnlockModal）。解锁/开锁/关锁各自校验 hash；**注意** `enableEncryption` 里 `set` 存的是明文内存态（`withEncrypted` 只用于落库），UI 展示用明文。改密码即重开锁（先 disable 再 enable），无"改密码"单独入口。TS 5.8 下 crypto 相关 BufferSource 参数必须 `Uint8Array<ArrayBuffer>`。
- **AI 重试**：`ai/retry.ts` 的 `withRetry` **只在出字前重试**——provider 用 `canRetry: () => !emitted` 禁止出字后重试（重发会重复内容），出字后流中断统一转成"输出过程中网络连接中断"普通错误。仅 `RetryableHttpError(retryable=true)` 与 TypeError 可重试；408/429/5xx/529（Anthropic 过载）可重试，401/403/400 等不重试；AbortError 直接透传。有 `Retry-After` 头优先采用（上限 60s），否则指数退避 1s→2s→4s（封顶 8s，±25% 抖动），默认最多重试 2 次。Anthropic SSE 里的 `type:"error"` 事件按 `anthropicErrorToStatus` 映射成等价状态码复用同一判定。测试夹具注意：`res.socket.destroy()` 必须等 `write` 回调刷出后再延迟执行，否则客户端 fetch 直接抛错走代理回退（代理在跑时会变成可重试的 502，断言路径完全不同）。
- **备份导入**：`backup.ts` 在单事务内清空四表再 bulkPut（保留原 id 与 chatSessions），成功后 `BackupModal` 直接 `location.reload()` 让所有 store 重载，别改成手动刷 state。
- **编辑器**：`Editor.tsx` 以 `chapterId` 为 key 销毁重建，`initialContent` 只在创建时生效；切章节的最新内容靠 `stores/project.ts` 的 `setActiveChapter` 从 DB 重取。保存是 600ms 防抖，`saveChapterContent` 落库后**同步刷新 store 里的 chapters**（续写取前文、字数统计都依赖内存是最新的，别删）。markdown 扩展刻意不挂 `codeLanguages`（language-data 会把全部语言模式打进产物）。
- **依赖变更**：卸载/更换依赖后必须重启 dev server——Vite 预构建缓存（`node_modules/.vite`）不会自动失效，页面会以 `xxx is not defined` 白屏。
- **AI**：OpenAI 兼容接口 baseUrl 不带 `/v1` 时自动补（见 `openai.ts` normalizeBase）；Anthropic 必须带 `anthropic-dangerous-direct-browser-access: true` 头且 system 单独抽出来传、messages 首条须为 user（`anthropic.ts` 已处理）。
- 流式 chunk 的 content 可能是字符串或数组，统一过 `utils.contentToString`。

## 参考

- `README.md`：功能清单、代理用法、测试方法。
- 角色卡规范：SillyTavern V2/V3 spec（仓库链接见 README 调研来源：character-card-spec-v2 / v3）。
