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

## 功能

- **多项目管理**：每部作品独立管理章节、角色卡、世界观设定与写作要求
- **章节编辑器**：CodeMirror 6 驱动的 Markdown 编辑器，字数统计、防抖自动保存（IndexedDB）；章节支持上移/下移排序，删除需两步确认
- **角色卡库**：导入 SillyTavern 角色卡（PNG / JSON，兼容 V1 / V2 / V3 规范），PNG 内嵌数据自动提取（ccv3 优先于 chara），原始卡片数据无损保留；卡内**世界书（character_book）自动并入项目 Lorebook**（`{{char}}`/`{{user}}` 宏导入时按来源卡解析）；勾选"参与"的角色设定会注入 AI 提示词；支持把角色**再导出为 PNG**（chara + ccv3 双写，可被 SillyTavern 直接读回）
- **世界观 Lorebook**：按词条维护设定（名称 / 触发关键词 / 内容 / 启用开关）。带关键词的词条仅在关键词出现在续写上下文中时注入提示词；不带关键词的词条为常驻设定，始终注入
- **导出**：全书导出为 Markdown 或 TXT（按章节分节）
- **AI 写作助手**：
  - 续写本章：自动拼装系统提示词（世界观 + Lorebook 相关词条 + 参与角色设定 + 写作要求）+ 最近正文上下文
  - 写作预设：导入 SillyTavern 预设 JSON（system 提示词 / context 模板 / 合订信封），自定义系统提示词与设定区块组装方式，也可手动新建编辑；仓库自带示例 `samples/preset-example.json`
  - 自由指令对话，流式输出，结果可"插入末尾 / 替换选区"；最后一条回复支持"重新生成"
  - 会话按项目持久化，刷新页面不丢失
  - 支持 OpenAI 兼容接口（OpenAI / DeepSeek / 中转站 / Ollama 等）与 Anthropic Claude 原生接口，可拉取模型列表，可调温度 / maxTokens / 上下文字数
  - 浏览器直连失败（疑似 CORS 限制）时自动回退本地代理，无需改配置
  - 请求失败自动重试：限流 / 服务过载（429 / 5xx / Anthropic overloaded）等临时错误指数退避重试最多 2 次（遵循 Retry-After），聊天面板显示重试进度，可随时停止；已开始输出后不会重试（避免内容重复）
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
node scripts/test-card-import.mjs   # 角色卡解析链路：PNG V2 / 双写 ccv3 / JSON / V1
node scripts/test-iteration.mjs     # 代理转发/安全校验 + PNG 导出回读（char-card-reader 验证）
node scripts/test-preset-import.mjs # 预设导入：四类 SillyTavern 预设 JSON + story_string 渲染 + 提示词组装
node scripts/test-ai-retry.mjs      # AI 请求重试：退避/Retry-After/状态码判定 + 真实 HTTP 集成（含出字后不重试）
```
