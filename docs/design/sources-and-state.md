# 资料源（sources）、通道与状态层

> 状态：**设计稿，待评审**。评审通过后按「实施切片」逐刀落地。
> 起因：真实社区卡（《道渊》v5.4.2，V3，10.25 MB）暴露出当前实现把「一个可运行的世界模块」当成「一个角色」处理。
> 关联：`docs/design/auto-writer.md`（写作闭环）、`AGENTS.md`（坑清单）。

## 1. 为什么要改

实测一张大型卡的结构：

| 卡字段 | 实测（道渊） | 说明 |
|---|---|---|
| `description` | 297 字 | 封面语，不是人物小传 |
| `first_mes` | 18,650 字 | 整个开篇剧本 |
| `personality` / `scenario` / `system_prompt` / `post_history_instructions` | 全 0 | 规则不写在这里 |
| `character_book` | **356 条 / 286,833 字**（中位 626，最长 7,586） | 卡的正文＝一整套世界设定集 |
| `extensions.tavern_helper.scripts` | 6 段（含 MVU-offline v1.0.2、Zod schema、1.03 MB 悬浮状态栏） | **玩法运行时** |
| `extensions.regex_scripts` | 21 条 | 状态栏/排版加工，含「剥离变量更新块」 |
| `character_book` 内部 | 设定 / 人物档案 / **生成规则** / **变量更新规则** 混排 | 全按关键词注入会按运气命中 |

当前实现的四处错位：

1. 卡 → `characters/<id>.json` 一行（容器错了）。
2. 世界观留在 `character.description`，不提升到项目层。
3. `system_prompt` / `post_history_instructions` / `extensions` 完全不读（玩法整条丢失，数据仍在 `rawData`）。
4. 注入预算 8 条 / 4000 字 vs 28.7 万字设定 → 99.9% 永远进不了简报。

## 2. 模型：source + channel

**项目 = 一本作品 + 若干挂载的资料源**。每个 source 声明自己的**通道**，通道决定"怎么用"。

```
source = { id, kind, name, enabled, priority, origin, entries[], rules?, state?, originals }
```

| kind | 典型内容 | 通道 | 触发 |
|---|---|---|---|
| `card` | 模块卡：世界 + 规则 + 初值 + 脚本（只读） | 拆成下面几类 | — |
| `lore` | 地理/组织/历史/秘境 | 设定区 | 关键词命中（现有机制） |
| `style` | 「冷峻克制」「章回体」「第一人称」 | 写作要求区 | 常驻，**多源可叠加**，按 `priority` 排序 |
| `gameplay` | MVU 更新规则、NPC/秘境生成规则、判定 | 规则区 | 常驻（**不按关键词抽**） |
| `state` | `[initvar]` 初值 + 状态机规则 | 状态层 | 初始化一次 + 每章更新 |
| `cast` | 人物档案条目 | 设定区 | 关键词命中（按名字） |
| `preset` | ST 预设（三种组，见 §4） | 结构层 | **唯一激活** |
| `material` | 开篇剧本、备选开场、UI 脚本 | 不注入 | 只读展示 |

### 硬约束

1. **状态源只能有一个激活**。两套 initvar / 两套 patch 规则同时跑，状态树当场打架；挂第二张卡时第一张的状态源自动降级为只读素材。
2. **预设（结构源）只能有一个激活**。两套 `story_string` 同时生效是灾难。
3. 文风可叠加但顺序显式；设定类同名条目按 `priority` 高者覆盖，并**报告冲突**。

## 3. 落盘形状（最小改动）

```
projects/<id>/
  lorebook.json                唯一注入池；每条加 source / channel / priority
  sources/<sourceId>/
    source.json                kind / enabled / priority / origin / 原始文件名
    entries.json               该源原始条目（含自动分类结果 + 人工覆盖）
    rules.md                   规则原文（card / gameplay）
    initvar.json               状态初值（card / state）
    card.json                  卡面：description / first_mes / extensions 摘要
    originals/                 原始 PNG/JSON 原件（只读备查）
  state.json                   唯一状态树
  state-log.jsonl              append-only 变更日志（第几章、谁、op、旧值→新值）
  presets.json                 保持现有形状（activePresetId 唯一）
```

`lorebook.json` 仍是唯一注入池 → `selectLoreEntries` / `rankLoreEntries` / 双上限 / 词条工具全部复用，只是注入时按 `channel` 分派。

向后兼容：新增字段一律可选，老项目照旧读（`channel` 缺省按 `keys` 是否为空推断：空=常驻设定，非空=关键词设定）。

## 4. 预设：一个文件，三组分流

| 组 | 字段 | 处理 |
|---|---|---|
| 结构 | `sysprompt.content`、`context.story_string`、`prompts[]`、`prompt_order[]` | **生效**；唯一激活；替换开场白与设定区块模板 |
| 采样 | `temperature` / `top_p` / `repetition_penalty` / `frequency_penalty` … | **不生效**（正文由当前会话写）；存下并在面板可见，附「要生效请在会话/agent 的模型配置里设」 |
| 格式 | `instruct.input_sequence` / `output_sequence`、`names_behavior`、`wrap_in_quotes` | **不适用**（写正文非对话）；同上明示 |

导入必须产出**生效报告**：`生效 N 项 / 不生效 M 项（逐项列出）`，不静默。

卡自带 `system_prompt` / `post_history_instructions` 与预设结构组冲突时，面板显式三选一：**预设优先（默认）/ 卡优先 / 都追加**。

## 5. 组装管线（`buildSystemPrompt` 的新顺序）

```
① 结构层：预设开场白模板 + story_string 设定区块模板
② 项目层：作品简介 / 全书大纲 / 世界观与背景
③ 通道内容：设定（命中词条）/ 文风（叠加，标来源）/ 玩法规则（常驻）/ 角色（参与写作的卡）
④ 状态层：当前状态快照（结构化渲染）
⑤ 输出规则
⑥ 每章动态（续写消息）：本章 goal + 最近原文
```

**关键口径（当前代码里的坑）**：`story_string` 存在时，现在的实现会**跳过**默认的世界观/角色区块。因此新通道必须**不吃模板替换**：

- `story_string` 只接管"设定类"区块（它自己会用 `wiBefore` 等变量渲染设定）；
- **文风 / 玩法规则 / 状态 / 全书大纲**一律无条件注入（与现有 `outline` 一致）。
- 测试钉住：「挂了预设之后，文风/规则/状态仍在简报里」。

## 6. 状态层：MVU 兼容

协议原文（卡内 `[mvu_update]变量输出格式`，3,768 字）要点：

- 模型在回复**末尾**输出 `<UpdateVariable><Analysis>…</Analysis><JSONPatch>[…]</JSONPatch></UpdateVariable>`。
- Patch 是 **JSON Patch (RFC 6902) 变体**：`replace / delta / insert / remove / move`；`path` 必须以 `/` 开头；数值 0~100 钳制；`$器灵台词` 路径为 `/$器灵台词`；`_` 前缀只读。
- `<Analysis>` 是强制逐类清单（每条变量"变了什么/没变"）——这正好对抗"模型忘记更新"。

我们的实现：

1. 导入 `[initvar]` → `state.json` 初值；`[mvu_update]*` → `gameplay` 规则条。
2. 章节保存时**解析并剥离** `<UpdateVariable>` 块（卡内 regex「[不发送]去除变量更新」就是这个动作），正文只留小说内容。
3. 应用 patch：路径校验 → 类型/范围钳制（按 initvar 形状 + `range` 声明，不引入 zod）→ 写 `state.json` + 追加 `state-log.jsonl`。
4. 下一章简报注入渲染后的状态（`状态栏` 模板或默认渲染）。
5. **单位换算**：卡按「每回合」写（如 `遭遇冷却` 每回合减 1 / 触发重置 15）。我们按章，折算规则写进导入报告由人核对；`delta` 累加仍照原样。

不做的部分（明确写进面板与文档）：
- 1 MB 悬浮状态栏、工坊/Wiki/小手机等**浏览器脚本不执行**（只读保存 + 展示"本卡自带这些"）。
- `extensions.tavern_helper.variables.phone_data` 是**手机 UI 设置**（背景图/音乐/头像），不是游戏状态，单独存。
- 卡内的成人向规则文本**原样保留给模型**；代码不添加任何创作倾向、也不改写。

## 7. 面板

左栏三个区：`章节` / `资料源` / `角色卡`。

- 资料源列表：图标区分 卡 / 设定书 / 文风书 / 玩法书 / 预设；显示挂载状态、来源文件、条目数与"不生效项"。
- 源详情：kind/通道/优先级、条目列表（**自动分类结果可逐条改**）、规则原文、初值树、"这个源贡献了什么"。
- **注入预览**：直接看到这一章最终拼成的四段（写作要求 / 设定 / 规则 / 状态）——顺序错了或漏了，一眼可见，不用推理。
- 状态区：状态树 + 最近变动（来自 `state-log.jsonl`）。

## 8. 实施切片（每刀独立可测）

| # | 内容 | 依赖 |
|---|---|---|
| 1 | source 数据形状 + 导入拆解（卡/世界书/预设三种）+ 自动分类 + 生效/不生效报告 | 无 |
| 2 | 通道分派进 `buildSystemPrompt`（文风/规则/状态不吃模板替换）+ 注入预览数据 | 1 |
| 3 | 状态层：initvar → state.json、`<UpdateVariable>` 解析/应用/剥离、state-log | 1 |
| 4 | 面板：资料源列表 + 源详情 + 分类可改 + 注入预览 | 1–2 |
| 5 | MVU 规则条分流（`[mvu_update]*` → gameplay）与单位换算报告 | 1 |
| 6 | 面板状态区 + 每章状态注入 | 3 |

每刀都要过的闸门：`npm run typecheck` + 相关 `test:*`；导入器另需一条**真实卡**的回归测试（见 §9）。

## 9. 测试点

- **真实卡回归**：用 `v5.4.2.png`（10.25 MB）验证导入：356 条全部落池、`[initvar]` 不被当词条、`[mvu_update]*` 进 gameplay、`<UpdateVariable>` 剥离、`first_mes` 进 material。
- **分类**：设定/人物/生成规则/变量规则的判定表（含误判样本，验证"可人工改"）。
- **预设**：三组分流；生效报告；`story_string` 存在时文风/规则/状态仍在简报（回归当前坑）。
- **状态**：patch 的 5 种 op、路径校验（缺 `/` 必须拒绝）、范围钳制、`$` 前缀、并发（面板与模型同时改 → CAS）。
- **上传上限**：当前 8 MB 会拒掉这张 10.25 MB 的卡 → 提到 32 MB 并测边界。

## 10. 已定（评审通过）

1. **多挂载**：项目 = 一本书 + 若干资料源（卡 / 设定书 / 文风书 / 玩法书 / 预设 / 素材），不是一个项目绑一张卡。
2. **排序用拖拽**（资料源与章节都是）；`↑↓` 按钮保留作键盘/触屏回退。
   章节拖拽已落地：路由 `action=reorder`（`target` + `before|after`）+ 面板鼠标事件拖拽（不用 HTML5 DnD：触屏不工作、jsdom 也模拟不出来）。
   路由层只做参数校验与委派，真正语义在 `domain/reorder.ts` 的 `computeReorder`。
3. **卡自带 `system_prompt` 与预设冲突 → 预设优先**（面板仍留三选一，默认这个）。
4. **采样参数 → 只读展示 + 提示**（存下来、面板可见、明说"要生效请在会话/agent 的模型配置里设"）。
   不做"导入时拒绝"：几乎所有真实预设都带采样参数，拒收等于把 99% 的预设挡在门外。
5. 导入自动分类 + 面板逐条可改。
