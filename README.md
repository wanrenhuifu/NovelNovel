# NovelNovel · AI 小说写作 IDE

一个跑在浏览器里的 AI 小说写作工作台：章节编辑、SillyTavern 角色卡导入、世界观 Lorebook、AI 续写，全部数据保存在本地（IndexedDB），无需后端服务器。

## 启动

```bash
npm install
npm run dev        # 开发：http://localhost:5173
npm run build      # 生产构建
npm run preview    # 预览构建产物
npm run proxy      # 可选：本地 CORS 代理（127.0.0.1:8788），仅当中转站限制跨域时需要
```

## 作为 DeepSeek Harness 插件使用

仓库里还带一个 dsh 插件（`dsh-plugin/`）：小说以**工作区里的普通文件**存放，agent 直接用
`novel_*` 工具建作品、写正文、导卡、维护词条、检索、导出；原本由应用自己调 LLM 的「续写」
改由 harness 承担，插件负责把作者的设定（世界观 / 命中词条 / 参与角色 / 写作预设 / 前文摘录）
组装成写作简报交给 agent。浏览器应用照旧可用，两者共用 `src/lib` 的同一份纯逻辑
（角色卡解析、预设解析、提示词组装、词条关键词匹配、章节排序、全文搜索、PNG 卡读写、字数统计）。

```bash
npm run build:plugin                              # 构建插件（lib/ 不入库，必须构建；改 src/ 后要重建）
dsh plugin --profile novelnovel add ./dsh-plugin  # 装进一个 profile（不存在会自动初始化）
npm run test:dsh                                 # 在真实 harness 服务上跑通全部工具（34 项检查）
```

装好后在会话里直接提写作需求即可，系统提示词会引导 agent 用工具；斜杠命令 `/novel`
直接打印当前作品状态（`/novel list` 列出全部，`/novel <作品>` 切换），技能 `novel-writing` /
`novel-cards` 保存写作流程与「卡/预设导入」的领域规则。数据布局、配置项与设计说明见
[dsh-plugin/README.md](dsh-plugin/README.md)。

## 功能

- **多项目管理**：每部作品独立管理章节、角色卡、世界观设定与写作要求
- **章节编辑器**：CodeMirror 6 驱动的 Markdown 编辑器，字数统计、防抖自动保存（IndexedDB）；章节**支持拖拽排序**（悬停显示拖拽手柄，拖动到目标位置的上方或下方释放即可；键盘 ↑/↓ 按钮同时保留），删除需两步确认；章节列表底部实时显示全书总字数
- **大纲模式**：左栏"大纲"页以鸟瞰视图列出全部章节（标题 + 首段预览 + 字数），点击跳转编辑，适合长篇小说整体把控节奏
- **章节标签**：章节可打标签（如"伏笔"、"高潮"、"待修"），悬停标签可移除；标签栏点击筛选，多章节批量归类
- **编辑器增强**：选中文本右键弹出 AI 菜单（润色 / 扩写 / 总结 / 复制选区）；工具栏"本章内搜索"按钮打开 CodeMirror 搜索面板（支持正则、替换），选中内容自动高亮全部匹配
- **角色卡库**：导入 SillyTavern 角色卡（PNG / JSON，兼容 V1 / V2 / V3 规范），PNG 内嵌数据自动提取（ccv3 优先于 chara），原始卡片数据无损保留；卡内**世界书（character_book）自动并入项目 Lorebook**（`{{char}}`/`{{user}}` 宏导入时按来源卡解析）；勾选"参与"的角色设定会注入 AI 提示词；支持把角色**再导出为 PNG**（chara + ccv3 双写，可被 SillyTavern 直接读回）
- **世界观 Lorebook**：按词条维护设定（名称 / 触发关键词 / 内容 / 启用开关）。带关键词的词条仅在关键词出现在续写上下文中时注入提示词；不带关键词的词条为常驻设定，始终注入
- **全文搜索**：顶栏"搜索"在全书章节标题与正文中检索（大小写不敏感），结果带关键词高亮与上下文摘要，↑↓ 选择、Enter 跳转到命中章节并把光标定位到命中处
- **导出**：全书导出为 Markdown 或 TXT（按章节分节）
- **AI 写作助手**：
  - 续写本章：自动拼装系统提示词（世界观 + Lorebook 相关词条 + 参与角色设定 + 写作要求）+ 最近正文上下文；可携带当前章节之前 N 章的尾部摘录作为连贯性参考（章节数与每章字数可在设置中调），前文同样参与 Lorebook 关键词匹配
  - 写作预设：导入 SillyTavern 预设 JSON（system 提示词 / context 模板 / 合订信封），自定义系统提示词与设定区块组装方式，也可手动新建编辑；仓库自带示例 `samples/preset-example.json`
  - 自由指令对话，流式输出，结果可"插入末尾 / 替换选区 / 一键复制"；最后一条回复支持"重新生成"
  - 快速指令模板：内置润色 / 扩写 / 总结，点击即按模板发起对话；模板中的 `{{selection}}` 自动替换为编辑器选中文本（无选区时填入输入框等你补充）；模板可在设置中新建 / 编辑 / 删除 / 恢复默认
  - 会话按项目持久化，刷新页面不丢失；可随时"清空会话"（两步确认）
  - 可限制发送给 AI 的对话轮数（设置"对话携带轮数"，0 = 全部），只影响请求、不影响本地完整记录
  - 支持 OpenAI 兼容接口（OpenAI / DeepSeek / 中转站 / Ollama 等）与 Anthropic Claude 原生接口，可拉取模型列表，可调温度 / maxTokens / 上下文字数
  - 浏览器直连失败（疑似 CORS 限制）时自动回退本地代理，无需改配置
  - 请求失败自动重试：限流 / 服务过载（429 / 5xx / Anthropic overloaded）等临时错误指数退避重试最多 2 次（遵循 Retry-After），聊天面板显示重试进度，可随时停止；已开始输出后不会重试（避免内容重复）
  - 自动续写：聊天面板顶部循环按钮开启后，每轮续写完成自动间隔若干秒触发下一轮（间隔可在设置中调，默认 5 秒），顶部显示倒计时；出错、手动发送指令、切换章节或停止都会打断循环
  - 上下文可视化：眼睛按钮展示本次请求实际注入 AI 的全部内容（系统提示词 / 前文摘录 / 当前章尾部 / 对话历史），每段可单独复制，用于调试提示词与排查注入问题
- **API Key 加密**：设置中可开启"加密锁"（主密码）。开启后所有 API Key 以 AES-GCM 密文保存在 IndexedDB，主密码不落盘、每次刷新页面需重新输入解锁；忘记主密码无法找回，解除加密锁需要当前密码
- **备份与恢复**：顶栏"备份"一键导出全部数据（作品、章节、角色卡、设置）为 JSON，可随时导入恢复（整体覆盖，含两步确认）

## CORS 代理（可选）

部分 OpenAI 兼容中转站不返回 CORS 头，浏览器无法直连。此时应用会自动尝试本地代理：

```bash
npm run proxy   # 监听 127.0.0.1:8788
```

代理只做透明转发（POST /proxy，流式回传），不存储任何内容；仅生成请求走代理，拉取模型列表仍直连。

## 技术栈

Vite + React 18 + TypeScript · Zustand · Dexie (IndexedDB) · CodeMirror 6 · Tailwind CSS v4 · @lenml/char-card-reader

## 测试

```bash
npm run test        # 全部纯逻辑单测（下面 7 个脚本）
node scripts/test-card-import.mjs   # 角色卡解析链路：PNG V2 / 双写 ccv3 / JSON / V1
node scripts/test-iteration.mjs     # 代理转发/安全校验 + PNG 导出回读（char-card-reader 验证）
node scripts/test-preset-import.mjs # 预设导入：四类 SillyTavern 预设 JSON + story_string 渲染 + 提示词组装
node scripts/test-ai-retry.mjs      # AI 请求重试：退避/Retry-After/状态码判定 + 真实 HTTP 集成（含出字后不重试）
node scripts/test-search.mjs        # 章节全文搜索：命中/摘要/标题/上限/顺序
node scripts/test-reorder.mjs       # 章节拖拽排序：边界/位移/规范化/不可变性
node scripts/test-crypto.mjs        # API Key 加密：enc/dec 往返 / 错密码 / IV 随机 / hash 一致性
npm run test:e2e    # Playwright 端到端（先 npm run build；自动拉起 preview + mock AI 上游）
```

E2E 覆盖：建作品/章节/正文持久化、章节重命名删除、全文搜索跳转、拖拽排序（刷新后保持）、续写链路（哨兵重建为最新正文 + mock 流式回复）、上下文预览、API Key 加密开锁解锁全流程（9 条用例，Chromium）。

插件相关：

```bash
npm run build:plugin      # 构建 dsh 插件产物（dsh-plugin/lib/，不入库）
npm run typecheck:plugin  # 插件类型检查（tsc -p dsh-plugin，严格模式）
npm run test:dsh          # 插件端到端验证：真实 harness 服务上驱动全部工具（34 项检查，不调用模型）
```
