import { useRef, useState } from "react";
import { X, Plus, Trash2, RefreshCw, Loader2, Upload, RotateCcw, Lock, Unlock } from "lucide-react";
import { useSettingsStore } from "../../stores/settings";
import { listModels } from "../../lib/ai";
import { importPresetFromFile } from "../../lib/presetImport";
import { uid } from "../../lib/utils";
import type { AIProvider, InstructionTemplate, Preset, ProviderType } from "../../types";
import { defaultInstructionTemplates } from "../../types";

interface Props {
  onClose: () => void;
}

const emptyProvider = (): AIProvider => ({
  id: uid(),
  name: "",
  type: "openai",
  baseUrl: "",
  apiKey: "",
  modelId: "",
  models: [],
});

const inputCls =
  "w-full rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-sm text-ink-100 outline-none placeholder:text-ink-600 focus:border-accent-500";
const labelCls = "mb-1 block text-xs text-ink-400";

const KIND_LABEL: Record<Preset["kind"], string> = {
  system: "System 提示词",
  context: "Context 模板",
  instruct: "Instruct 格式",
};

export function SettingsModal({ onClose }: Props) {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const upsertProvider = useSettingsStore((s) => s.upsertProvider);
  const removeProvider = useSettingsStore((s) => s.removeProvider);
  const setActiveProvider = useSettingsStore((s) => s.setActiveProvider);
  const upsertPreset = useSettingsStore((s) => s.upsertPreset);
  const removePreset = useSettingsStore((s) => s.removePreset);
  const setActivePreset = useSettingsStore((s) => s.setActivePreset);

  const [draft, setDraft] = useState<AIProvider | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [presetDraft, setPresetDraft] = useState<Preset | null>(null);
  const [importingPreset, setImportingPreset] = useState(false);
  const [presetMsg, setPresetMsg] = useState<string | null>(null);
  const presetFileRef = useRef<HTMLInputElement>(null);

  const [tplDraft, setTplDraft] = useState<InstructionTemplate | null>(null);
  const [tplMsg, setTplMsg] = useState<string | null>(null);

  if (!settings) return null;

  const saveDraft = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.baseUrl.trim() || !draft.modelId.trim()) {
      setMsg("名称、API 地址和模型 ID 为必填项");
      return;
    }
    await upsertProvider({
      ...draft,
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      modelId: draft.modelId.trim(),
    });
    setDraft(null);
    setMsg(null);
  };

  const fetchModels = async () => {
    if (!draft) return;
    setFetchingModels(true);
    setMsg(null);
    try {
      const models = await listModels(draft);
      setDraft({ ...draft, models });
      if (!draft.modelId && models.length > 0) {
        setDraft({ ...draft, models, modelId: models[0] });
      }
      setMsg(`获取到 ${models.length} 个模型`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setFetchingModels(false);
    }
  };

  const handlePresetFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setImportingPreset(true);
    setPresetMsg(null);
    try {
      const { preset, note } = await importPresetFromFile(file);
      await upsertPreset(preset);
      setPresetMsg(
        note
          ? `已导入「${preset.name}」。${note}`
          : `已导入预设「${preset.name}」`,
      );
    } catch (e) {
      setPresetMsg(
        `导入失败：${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setImportingPreset(false);
      if (presetFileRef.current) presetFileRef.current.value = "";
    }
  };

  const savePresetDraft = async () => {
    if (!presetDraft) return;
    if (!presetDraft.name.trim()) {
      setPresetMsg("预设名称不能为空");
      return;
    }
    // 手动编辑可能改变内容构成，kind 按实际内容重新归类（导入的原始 JSON 不受影响）
    const kind: Preset["kind"] =
      presetDraft.kind === "instruct"
        ? "instruct"
        : presetDraft.storyString.trim()
          ? "context"
          : "system";
    await upsertPreset({ ...presetDraft, name: presetDraft.name.trim(), kind });
    setPresetDraft(null);
    setPresetMsg(null);
  };

  const saveTplDraft = async () => {
    if (!tplDraft) return;
    if (!tplDraft.name.trim() || !tplDraft.content.trim()) {
      setTplMsg("模板名称与指令内容不能为空");
      return;
    }
    const cleaned = { ...tplDraft, name: tplDraft.name.trim(), content: tplDraft.content.trim() };
    const list = settings.instructionTemplates.some((t) => t.id === cleaned.id)
      ? settings.instructionTemplates.map((t) => (t.id === cleaned.id ? cleaned : t))
      : [...settings.instructionTemplates, cleaned];
    await update({ instructionTemplates: list });
    setTplDraft(null);
    setTplMsg(null);
  };

  const removeTpl = async (id: string) => {
    await update({
      instructionTemplates: settings.instructionTemplates.filter((t) => t.id !== id),
    });
  };

  const restoreDefaultTpl = async () => {
    await update({ instructionTemplates: defaultInstructionTemplates });
    setTplDraft(null);
    setTplMsg("已恢复默认模板（润色 / 扩写 / 总结）");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
          <h2 className="text-base font-semibold text-ink-100">设置</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
          {/* 服务商列表 */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium text-ink-200">AI 服务商</h3>
              <button
                onClick={() => setDraft(emptyProvider())}
                className="flex items-center gap-1 rounded-md bg-accent-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-accent-500"
              >
                <Plus size={13} /> 添加
              </button>
            </div>

            {settings.providers.length === 0 && (
              <p className="rounded-md border border-dashed border-ink-700 px-3 py-4 text-center text-xs text-ink-400">
                尚未配置任何服务商。点击“添加”配置 OpenAI 兼容接口（OpenAI / DeepSeek / 中转站 / Ollama 等）或 Anthropic Claude。
              </p>
            )}

            <div className="space-y-2">
              {settings.providers.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5"
                >
                  <input
                    type="radio"
                    name="active-provider"
                    checked={settings.activeProviderId === p.id}
                    onChange={() => setActiveProvider(p.id)}
                    className="accent-amber-500"
                    title="设为当前使用"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-ink-100">{p.name}</span>
                      <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-ink-300">
                        {p.type === "anthropic" ? "Anthropic" : "OpenAI 兼容"}
                      </span>
                    </div>
                    <div className="truncate text-[11px] text-ink-400">
                      {p.baseUrl} · {p.modelId}
                    </div>
                  </div>
                  <button
                    onClick={() => setDraft(p)}
                    className="text-xs text-accent-400 hover:underline"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => removeProvider(p.id)}
                    className="rounded p-1 text-ink-400 hover:text-red-400"
                    title="删除"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* 编辑表单 */}
          {draft && (
            <section className="space-y-3 rounded-lg border border-accent-600/40 bg-ink-850/60 p-4">
              <h4 className="text-sm font-medium text-ink-100">
                {settings.providers.some((p) => p.id === draft.id)
                  ? "编辑服务商"
                  : "新增服务商"}
              </h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>名称</label>
                  <input
                    className={inputCls}
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="如：DeepSeek"
                  />
                </div>
                <div>
                  <label className={labelCls}>类型</label>
                  <select
                    className={inputCls}
                    value={draft.type}
                    onChange={(e) =>
                      setDraft({ ...draft, type: e.target.value as ProviderType })
                    }
                  >
                    <option value="openai">OpenAI 兼容</option>
                    <option value="anthropic">Anthropic Claude</option>
                  </select>
                </div>
              </div>
              <div>
                <label className={labelCls}>
                  API 地址
                  {draft.type === "anthropic"
                    ? "（官方可留空，默认 https://api.anthropic.com）"
                    : "（如 https://api.deepseek.com，无需带 /v1）"}
                </label>
                <input
                  className={inputCls}
                  value={draft.baseUrl}
                  onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                  placeholder="https://api.example.com"
                />
              </div>
              <div>
                <label className={labelCls}>API Key</label>
                <input
                  type="password"
                  className={inputCls}
                  value={draft.apiKey}
                  onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                  placeholder="sk-..."
                />
              </div>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className={labelCls}>模型</label>
                  {draft.models.length > 0 ? (
                    <select
                      className={inputCls}
                      value={draft.modelId}
                      onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
                    >
                      {draft.models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className={inputCls}
                      value={draft.modelId}
                      onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
                      placeholder="模型 ID，如 deepseek-chat"
                    />
                  )}
                </div>
                <button
                  onClick={fetchModels}
                  disabled={fetchingModels || !draft.baseUrl.trim() || !draft.apiKey.trim()}
                  className="flex items-center gap-1.5 rounded-md border border-ink-600 px-3 py-1.5 text-xs text-ink-200 hover:bg-ink-700 disabled:opacity-40"
                >
                  {fetchingModels ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <RefreshCw size={13} />
                  )}
                  拉取模型
                </button>
              </div>
              {msg && <p className="text-xs text-accent-400">{msg}</p>}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={saveDraft}
                  className="rounded-md bg-accent-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-500"
                >
                  保存
                </button>
                <button
                  onClick={() => {
                    setDraft(null);
                    setMsg(null);
                  }}
                  className="rounded-md border border-ink-600 px-4 py-1.5 text-sm text-ink-200 hover:bg-ink-700"
                >
                  取消
                </button>
              </div>
            </section>
          )}

          {/* 写作预设 */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium text-ink-200">写作预设</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setPresetDraft({
                      id: uid(),
                      name: "",
                      kind: "system",
                      systemPrompt: "",
                      storyString: "",
                      createdAt: Date.now(),
                    });
                    setPresetMsg(null);
                  }}
                  className="flex items-center gap-1 rounded-md border border-ink-600 px-2.5 py-1 text-xs text-ink-200 hover:bg-ink-700"
                >
                  <Plus size={13} /> 新建
                </button>
                <button
                  onClick={() => presetFileRef.current?.click()}
                  disabled={importingPreset}
                  className="flex items-center gap-1 rounded-md bg-accent-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-accent-500 disabled:opacity-50"
                >
                  {importingPreset ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Upload size={13} />
                  )}
                  导入 JSON
                </button>
                <input
                  ref={presetFileRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={(e) => handlePresetFile(e.target.files)}
                />
              </div>
            </div>

            <p className="mb-2 text-[11px] leading-relaxed text-ink-400">
              兼容 SillyTavern 预设 JSON（system 提示词、context 模板或两者合订的信封文件）。
              激活预设后：系统提示词替换默认开场白（支持{" "}
              <code className="text-accent-400">{"{{char}}"}</code> /{" "}
              <code className="text-accent-400">{"{{user}}"}</code> 宏）；
              story_string 按模板重组设定区块（变量：description / personality /
              scenario / system（写作要求）/ wiBefore（lorebook）等）。
            </p>

            {presetMsg && (
              <p
                className={`mb-2 text-xs ${
                  presetMsg.startsWith("导入失败") || presetMsg.startsWith("预设名称")
                    ? "text-red-400"
                    : "text-accent-400"
                }`}
              >
                {presetMsg}
              </p>
            )}

            <div className="space-y-2">
              <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 hover:border-ink-600">
                <input
                  type="radio"
                  name="active-preset"
                  checked={settings.activePresetId === null}
                  onChange={() => setActivePreset(null)}
                  className="accent-amber-500"
                  title="不使用预设"
                />
                <div className="min-w-0 flex-1">
                  <span className="text-sm text-ink-100">默认内置</span>
                  <div className="text-[11px] text-ink-400">
                    中文小说写作提示词与默认设定区块
                  </div>
                </div>
              </label>

              {settings.presets.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5"
                >
                  <input
                    type="radio"
                    name="active-preset"
                    checked={settings.activePresetId === p.id}
                    onChange={() => setActivePreset(p.id)}
                    className="accent-amber-500"
                    title="设为当前使用"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-ink-100">{p.name}</span>
                      <span className="shrink-0 rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-ink-300">
                        {KIND_LABEL[p.kind]}
                      </span>
                    </div>
                    <div className="truncate text-[11px] text-ink-400">
                      {p.storyString.trim()
                        ? "含设定区块模板"
                        : p.systemPrompt.trim()
                          ? "含自定义系统提示词"
                          : "仅存档（不参与提示词组装）"}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setPresetDraft(p);
                      setPresetMsg(null);
                    }}
                    className="text-xs text-accent-400 hover:underline"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => removePreset(p.id)}
                    className="rounded p-1 text-ink-400 hover:text-red-400"
                    title="删除"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>

            {presetDraft && (
              <div className="mt-3 space-y-3 rounded-lg border border-accent-600/40 bg-ink-850/60 p-4">
                <h4 className="text-sm font-medium text-ink-100">
                  {settings.presets.some((p) => p.id === presetDraft.id)
                    ? "编辑预设"
                    : "新增预设"}
                </h4>
                <div>
                  <label className={labelCls}>名称</label>
                  <input
                    className={inputCls}
                    value={presetDraft.name}
                    onChange={(e) =>
                      setPresetDraft({ ...presetDraft, name: e.target.value })
                    }
                    placeholder="预设名称"
                  />
                </div>
                <div>
                  <label className={labelCls}>
                    系统提示词（替换默认开场白；{"{{char}}"} = 首个参与角色，
                    {"{{user}}"} = 主角；留空则用内置默认）
                  </label>
                  <textarea
                    className={`${inputCls} min-h-24 resize-y`}
                    value={presetDraft.systemPrompt}
                    onChange={(e) =>
                      setPresetDraft({ ...presetDraft, systemPrompt: e.target.value })
                    }
                    placeholder="你是一位资深网文作家，正在以 {{char}} 的视角续写……"
                  />
                </div>
                <div>
                  <label className={labelCls}>
                    设定区块模板 story_string（留空则用默认区块；支持
                    {" {{#if 变量}}…{{/if}} "}条件块）
                  </label>
                  <textarea
                    className={`${inputCls} min-h-32 resize-y font-mono text-xs`}
                    value={presetDraft.storyString}
                    onChange={(e) =>
                      setPresetDraft({ ...presetDraft, storyString: e.target.value })
                    }
                    placeholder={
                      "{{#if worldbuilding}}## 世界观\n{{worldbuilding}}\n{{/if}}{{#if description}}{{description}}\n{{/if}}{{#if system}}## 写作要求\n{{system}}{{/if}}"
                    }
                  />
                </div>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={savePresetDraft}
                    className="rounded-md bg-accent-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-500"
                  >
                    保存
                  </button>
                  <button
                    onClick={() => {
                      setPresetDraft(null);
                      setPresetMsg(null);
                    }}
                    className="rounded-md border border-ink-600 px-4 py-1.5 text-sm text-ink-200 hover:bg-ink-700"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* 快速指令模板 */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium text-ink-200">快速指令模板</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void restoreDefaultTpl()}
                  className="flex items-center gap-1 rounded-md border border-ink-600 px-2.5 py-1 text-xs text-ink-200 hover:bg-ink-700"
                  title="覆盖为内置的润色 / 扩写 / 总结模板"
                >
                  <RotateCcw size={13} /> 恢复默认
                </button>
                <button
                  onClick={() => {
                    setTplDraft({ id: uid(), name: "", content: "" });
                    setTplMsg(null);
                  }}
                  className="flex items-center gap-1 rounded-md bg-accent-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-accent-500"
                >
                  <Plus size={13} /> 新建
                </button>
              </div>
            </div>

            <p className="mb-2 text-[11px] leading-relaxed text-ink-400">
              模板以快捷按钮显示在聊天输入框上方，点击即按该指令发起对话。指令内容里的{" "}
              <code className="text-accent-400">{"{{selection}}"}</code>{" "}
              会在发送时替换为编辑器当前选中的文本；无选区时不自动发送，只填入输入框等你补充。
            </p>

            {tplMsg && (
              <p
                className={`mb-2 text-xs ${
                  tplMsg.startsWith("模板名称") ? "text-red-400" : "text-accent-400"
                }`}
              >
                {tplMsg}
              </p>
            )}

            <div className="space-y-2">
              {settings.instructionTemplates.length === 0 && (
                <p className="rounded-md border border-dashed border-ink-700 px-3 py-4 text-center text-xs text-ink-400">
                  暂无模板。点击“新建”添加，或“恢复默认”使用内置的润色 / 扩写 / 总结模板。
                </p>
              )}
              {settings.instructionTemplates.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <span className="text-sm text-ink-100">{t.name}</span>
                    <div className="truncate text-[11px] text-ink-400">{t.content}</div>
                  </div>
                  <button
                    onClick={() => {
                      setTplDraft(t);
                      setTplMsg(null);
                    }}
                    className="text-xs text-accent-400 hover:underline"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => void removeTpl(t.id)}
                    className="rounded p-1 text-ink-400 hover:text-red-400"
                    title="删除"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>

            {tplDraft && (
              <div className="mt-3 space-y-3 rounded-lg border border-accent-600/40 bg-ink-850/60 p-4">
                <h4 className="text-sm font-medium text-ink-100">
                  {settings.instructionTemplates.some((t) => t.id === tplDraft.id)
                    ? "编辑模板"
                    : "新增模板"}
                </h4>
                <div>
                  <label className={labelCls}>名称（按钮文字）</label>
                  <input
                    className={inputCls}
                    value={tplDraft.name}
                    onChange={(e) => setTplDraft({ ...tplDraft, name: e.target.value })}
                    placeholder="如：润色"
                  />
                </div>
                <div>
                  <label className={labelCls}>
                    指令内容（<code>{"{{selection}}"}</code> = 编辑器选中文本）
                  </label>
                  <textarea
                    className={`${inputCls} min-h-24 resize-y`}
                    value={tplDraft.content}
                    onChange={(e) => setTplDraft({ ...tplDraft, content: e.target.value })}
                    placeholder={"请润色以下段落：\n\n{{selection}}"}
                  />
                </div>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => void saveTplDraft()}
                    className="rounded-md bg-accent-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-500"
                  >
                    保存
                  </button>
                  <button
                    onClick={() => {
                      setTplDraft(null);
                      setTplMsg(null);
                    }}
                    className="rounded-md border border-ink-600 px-4 py-1.5 text-sm text-ink-200 hover:bg-ink-700"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* 生成参数 */}
          <section className="space-y-3">
            <h3 className="text-sm font-medium text-ink-200">生成参数</h3>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={labelCls}>温度 ({settings.temperature})</label>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={settings.temperature}
                  onChange={(e) => update({ temperature: Number(e.target.value) })}
                  className="w-full accent-amber-500"
                />
              </div>
              <div>
                <label className={labelCls}>单次最大 Token</label>
                <input
                  type="number"
                  min={100}
                  max={32000}
                  className={inputCls}
                  value={settings.maxTokens}
                  onChange={(e) => update({ maxTokens: Number(e.target.value) || 1000 })}
                />
              </div>
              <div>
                <label className={labelCls}>续写上下文（字数）</label>
                <input
                  type="number"
                  min={200}
                  max={50000}
                  className={inputCls}
                  value={settings.contextChars}
                  onChange={(e) => update({ contextChars: Number(e.target.value) || 3000 })}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={labelCls}>携带前文章节数（0 = 不携带）</label>
                <input
                  type="number"
                  min={0}
                  max={10}
                  className={inputCls}
                  value={settings.prevChapterCount}
                  onChange={(e) =>
                    update({ prevChapterCount: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
              </div>
              <div>
                <label className={labelCls}>每个前文章节取尾部（字数）</label>
                <input
                  type="number"
                  min={200}
                  max={10000}
                  className={inputCls}
                  value={settings.prevChapterChars}
                  onChange={(e) =>
                    update({ prevChapterChars: Number(e.target.value) || 1500 })
                  }
                />
              </div>
              <div>
                <label className={labelCls}>对话携带轮数（0 = 全部）</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  className={inputCls}
                  value={settings.chatContextTurns}
                  onChange={(e) =>
                    update({ chatContextTurns: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={labelCls}>自动续写间隔（毫秒）</label>
                <input
                  type="number"
                  min={1000}
                  max={60000}
                  step={500}
                  className={inputCls}
                  value={settings.autoContinueIntervalMs}
                  onChange={(e) =>
                    update({
                      autoContinueIntervalMs: Math.max(1000, Number(e.target.value) || 5000),
                    })
                  }
                />
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-ink-400">
              续写时除当前章节结尾外，还会携带前面章节的尾部摘录作为参考（前文同样参与 Lorebook 关键词匹配）。
              对话携带轮数只影响发给 AI 的历史，界面与本地会话始终保留完整记录。
              自动续写开启后，每轮续写完成会按上方间隔自动触发下一轮，在聊天面板顶部循环图标处看到倒计时；
              出错、用户手动发送指令、切换章节或点停止都会打断循环。
              API Key 仅保存在本机浏览器的 IndexedDB 中，请求默认从浏览器直连服务商；
              若服务商存在 CORS 限制，直连会自动回退到本地代理——
              在项目目录运行 <code className="text-accent-400">npm run proxy</code>（端口 8788）即可，无需改任何配置。
            </p>
          </section>

          <EncryptionSection />
        </div>
      </div>
    </div>
  );
}

/** 加密锁管理：设置/解除主密码；启用后 API Key 在 IndexedDB 里以密文保存 */
function EncryptionSection() {
  const settings = useSettingsStore((s) => s.settings);
  const enableEncryption = useSettingsStore((s) => s.enableEncryption);
  const disableEncryption = useSettingsStore((s) => s.disableEncryption);

  const [newPassword, setNewPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const enabled = settings?.masterHash != null;

  const handleEnable = async () => {
    if (!newPassword) return;
    setBusy(true);
    setMsg(null);
    const result = await enableEncryption(newPassword);
    setBusy(false);
    if (result.ok) {
      setNewPassword("");
      setMsg({ kind: "ok", text: "加密锁已开启；本轮会话无需再次输入，刷新页面后需重输" });
    } else {
      setMsg({ kind: "err", text: result.error ?? "开启失败" });
    }
  };

  const handleDisable = async () => {
    if (!currentPassword) return;
    setBusy(true);
    setMsg(null);
    const result = await disableEncryption(currentPassword);
    setBusy(false);
    if (result.ok) {
      setCurrentPassword("");
      setMsg({ kind: "ok", text: "加密锁已解除；所有 API Key 已解密并以明文保存" });
    } else {
      setMsg({ kind: "err", text: result.error ?? "解除失败" });
    }
  };

  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-1.5 text-sm font-medium text-ink-200">
        {enabled ? <Lock size={14} /> : <Unlock size={14} />} 加密锁
      </h3>
      {enabled ? (
        <div className="space-y-2">
          <p className="text-[11px] leading-relaxed text-ink-400">
            已启用：所有 API Key 以密文保存在 IndexedDB，每次刷新页面需要输入主密码解锁本轮会话。
          </p>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="当前主密码"
            className={inputCls}
          />
          <button
            onClick={() => void handleDisable()}
            disabled={!currentPassword || busy}
            className="rounded-md border border-red-800 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-40"
          >
            解除加密锁
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[11px] leading-relaxed text-ink-400">
            设置后所有 API Key 会以 AES-GCM 加密后再保存到 IndexedDB，
            每次刷新页面需输入主密码解锁本轮会话；请牢记主密码，忘记无法找回。
          </p>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="新主密码（至少 4 位）"
            className={inputCls}
          />
          <button
            onClick={() => void handleEnable()}
            disabled={!newPassword || busy}
            className="rounded-md bg-accent-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-500 disabled:opacity-40"
          >
            开启加密锁
          </button>
        </div>
      )}
      {msg && (
        <p
          className={`text-[11px] ${msg.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}
        >
          {msg.text}
        </p>
      )}
    </section>
  );
}
