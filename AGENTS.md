# AGENTS.md

AI 小说写作 IDE（纯前端 Web 应用，无后端；可选本地 CORS 代理见下）。数据全部存浏览器 IndexedDB（Dexie），API Key 也存本地。UI 文案为简体中文，暗色暖调主题。

## 命令

```bash
npm run dev                        # 开发 http://localhost:5173
npm run build                      # tsc -b + vite build（严格模式，零错误才过）
npm run proxy                      # 可选：本地 CORS 代理 127.0.0.1:8788
node scripts/test-card-import.mjs  # 角色卡解析链路测试（PNG V2 / ccv3 双写 / JSON / V1）
node scripts/test-iteration.mjs    # 代理转发/安全校验 + PNG 导出回读测试
node scripts/test-preset-import.mjs # 预设导入解析 + story_string 渲染 + 提示词组装测试
node scripts/test-ai-retry.mjs     # AI 请求重试：退避/Retry-After/状态码 + 真实 HTTP 集成
```

无 lint 配置；无 git 仓库。

## 技术栈

Vite + React 18 + TS（strict、noUnusedLocals/Parameters、verbatimModuleSyntax）· Zustand · Dexie · CodeMirror 6 · Tailwind CSS **v4**（CSS-first，经 `@tailwindcss/vite`，无 tailwind.config）· lucide-react · `@lenml/char-card-reader`。

## 架构边界

- `src/lib/` 纯逻辑，不依赖 React：`db.ts`（Dexie schema 与设置读写）、`cardImport.ts`（角色卡解析）、`presetImport.ts`（SillyTavern 预设 JSON 解析：system/context/instruct 裸预设 + 合订信封）、`prompt.ts`（system prompt 组装、`{{char}}`/`{{user}}` 宏替换、lorebook 词条按关键词注入、story_string 渲染）、`export.ts`（全书 md/txt 导出、角色卡 PNG 再导出、`downloadBlob` 下载工具）、`backup.ts`（全量 JSON 备份导出/导入覆盖）、`png.ts`（纯浏览器 PNG chunk 读写 + CompressionStream deflate）、`ai/`（`index.ts` 按 provider.type 分发；`openai.ts`/`anthropic.ts` 各自实现流式；`sse.ts` 手工解析 SSE，不引 SDK；`proxy.ts` 直连失败自动回退本地代理；`retry.ts` 出字前失败自动重试的判定/退避）。
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
- **AI 重试**：`ai/retry.ts` 的 `withRetry` **只在出字前重试**——provider 用 `canRetry: () => !emitted` 禁止出字后重试（重发会重复内容），出字后流中断统一转成"输出过程中网络连接中断"普通错误。仅 `RetryableHttpError(retryable=true)` 与 TypeError 可重试；408/429/5xx/529（Anthropic 过载）可重试，401/403/400 等不重试；AbortError 直接透传。有 `Retry-After` 头优先采用（上限 60s），否则指数退避 1s→2s→4s（封顶 8s，±25% 抖动），默认最多重试 2 次。Anthropic SSE 里的 `type:"error"` 事件按 `anthropicErrorToStatus` 映射成等价状态码复用同一判定。测试夹具注意：`res.socket.destroy()` 必须等 `write` 回调刷出后再延迟执行，否则客户端 fetch 直接抛错走代理回退（代理在跑时会变成可重试的 502，断言路径完全不同）。
- **备份导入**：`backup.ts` 在单事务内清空四表再 bulkPut（保留原 id 与 chatSessions），成功后 `BackupModal` 直接 `location.reload()` 让所有 store 重载，别改成手动刷 state。
- **编辑器**：`Editor.tsx` 以 `chapterId` 为 key 销毁重建，`initialContent` 只在创建时生效；切章节的最新内容靠 `stores/project.ts` 的 `setActiveChapter` 从 DB 重取。保存是 600ms 防抖。markdown 扩展刻意不挂 `codeLanguages`（language-data 会把全部语言模式打进产物）。
- **依赖变更**：卸载/更换依赖后必须重启 dev server——Vite 预构建缓存（`node_modules/.vite`）不会自动失效，页面会以 `xxx is not defined` 白屏。
- **AI**：OpenAI 兼容接口 baseUrl 不带 `/v1` 时自动补（见 `openai.ts` normalizeBase）；Anthropic 必须带 `anthropic-dangerous-direct-browser-access: true` 头且 system 单独抽出来传、messages 首条须为 user（`anthropic.ts` 已处理）。
- 流式 chunk 的 content 可能是字符串或数组，统一过 `utils.contentToString`。

## 参考

- `README.md`：功能清单、代理用法、测试方法。
- 角色卡规范：SillyTavern V2/V3 spec（仓库链接见 README 调研来源：character-card-spec-v2 / v3）。
