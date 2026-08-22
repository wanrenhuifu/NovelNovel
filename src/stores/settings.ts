import { create } from "zustand";
import type { AIProvider, AppSettings, Preset } from "../types";
import { getSettings, saveSettings } from "../lib/db";
import {
  encryptApiKey,
  decryptApiKey,
  hashPassword,
  newPasswordSalt,
  looksEncrypted,
} from "../lib/crypto";

/**
 * 会话内的主密码：仅存内存，刷新即失。
 * 非空时所有 apiKey 落库前会加密，载入时会解密。
 */
let sessionPassword: string | null = null;

interface SettingsState {
  settings: AppSettings | null;
  loaded: boolean;
  /** 任何 apiKey 已加密且尚未解锁时为 true，UI 据此弹出解锁窗 */
  locked: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  upsertProvider: (provider: AIProvider) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  setActiveProvider: (id: string | null) => Promise<void>;
  upsertPreset: (preset: Preset) => Promise<void>;
  removePreset: (id: string) => Promise<void>;
  setActivePreset: (id: string | null) => Promise<void>;
  /** 主密码正确后解锁：解密所有 apiKey 到内存 */
  unlock: (password: string) => Promise<{ ok: boolean; error?: string }>;
  /** 开启加密锁：设定主密码，立即加密所有现有 apiKey */
  enableEncryption: (
    password: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** 关闭加密锁：需要当前密码，解密后落库 */
  disableEncryption: (
    password: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}

/** 把内存里（明文）的 apiKey 加密后返回新 settings */
async function encryptAllKeys(s: AppSettings): Promise<AppSettings> {
  if (!sessionPassword) return s;
  const providers = await Promise.all(
    s.providers.map(async (p) =>
      p.apiKey && !looksEncrypted(p.apiKey)
        ? { ...p, apiKey: await encryptApiKey(p.apiKey, sessionPassword!) }
        : p,
    ),
  );
  return { ...s, providers };
}

/** 把（可能加密的）apiKey 全部解密；任一失败则抛错 */
async function decryptAllKeys(s: AppSettings, password: string): Promise<AppSettings> {
  const providers = await Promise.all(
    s.providers.map(async (p) =>
      looksEncrypted(p.apiKey)
        ? { ...p, apiKey: await decryptApiKey(p.apiKey, password) }
        : p,
    ),
  );
  return { ...s, providers };
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: null,
  loaded: false,
  locked: false,

  async load() {
    const settings = await getSettings();
    const anyEncrypted = settings.providers.some((p) => looksEncrypted(p.apiKey));
    if (anyEncrypted && !sessionPassword) {
      // 有加密 key 且本轮未解锁：保留加密形式，UI 层据此弹出解锁窗
      set({ settings, loaded: true, locked: true });
      return;
    }
    if (anyEncrypted && sessionPassword) {
      try {
        const decrypted = await decryptAllKeys(settings, sessionPassword);
        set({ settings: decrypted, loaded: true, locked: false });
        return;
      } catch {
        // 密码变了或数据损坏：回退到锁定态
        set({ settings, loaded: true, locked: true });
        return;
      }
    }
    set({ settings, loaded: true, locked: false });
  },

  async update(patch) {
    const current = get().settings;
    if (!current) return;
    const next = { ...current, ...patch };
    await saveSettings(await encryptAllKeys(next));
    set({ settings: next });
  },

  async upsertProvider(provider) {
    const current = get().settings;
    if (!current) return;
    const providers = current.providers.some((p) => p.id === provider.id)
      ? current.providers.map((p) => (p.id === provider.id ? provider : p))
      : [...current.providers, provider];
    const activeProviderId = current.activeProviderId ?? provider.id;
    const next = { ...current, providers, activeProviderId };
    await saveSettings(await encryptAllKeys(next));
    set({ settings: next });
  },

  async removeProvider(id) {
    const current = get().settings;
    if (!current) return;
    const providers = current.providers.filter((p) => p.id !== id);
    const activeProviderId =
      current.activeProviderId === id
        ? (providers[0]?.id ?? null)
        : current.activeProviderId;
    const next = { ...current, providers, activeProviderId };
    await saveSettings(await encryptAllKeys(next));
    set({ settings: next });
  },

  async setActiveProvider(id) {
    await get().update({ activeProviderId: id });
  },

  async upsertPreset(preset) {
    const current = get().settings;
    if (!current) return;
    const presets = current.presets.some((p) => p.id === preset.id)
      ? current.presets.map((p) => (p.id === preset.id ? preset : p))
      : [...current.presets, preset];
    await saveSettings({ ...current, presets });
    set({ settings: { ...current, presets } });
  },

  async removePreset(id) {
    const current = get().settings;
    if (!current) return;
    const presets = current.presets.filter((p) => p.id !== id);
    const activePresetId =
      current.activePresetId === id ? null : current.activePresetId;
    const next = { ...current, presets, activePresetId };
    await saveSettings(next);
    set({ settings: next });
  },

  async setActivePreset(id) {
    await get().update({ activePresetId: id });
  },

  async unlock(password) {
    const current = get().settings;
    if (!current || !current.masterHash || !current.masterSalt) {
      return { ok: false, error: "未设置加密锁" };
    }
    const computed = await hashPassword(password, current.masterSalt);
    if (computed !== current.masterHash) {
      return { ok: false, error: "主密码错误" };
    }
    try {
      const decrypted = await decryptAllKeys(current, password);
      sessionPassword = password;
      set({ settings: decrypted, locked: false });
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "解密失败",
      };
    }
  },

  async enableEncryption(password) {
    const current = get().settings;
    if (!current) return { ok: false, error: "未加载设置" };
    if (password.length < 4) {
      return { ok: false, error: "主密码至少 4 位" };
    }
    const salt = newPasswordSalt();
    const masterHash = await hashPassword(password, salt);
    sessionPassword = password;
    // 立即把所有 apiKey 加密后落库
    const withEncrypted = await encryptAllKeys(current);
    const next = { ...withEncrypted, masterHash, masterSalt: salt };
    await saveSettings(next);
    set({ settings: { ...current, masterHash, masterSalt: salt } });
    return { ok: true };
  },

  async disableEncryption(password) {
    const current = get().settings;
    if (!current || !current.masterSalt) {
      return { ok: false, error: "未设置加密锁" };
    }
    const computed = await hashPassword(password, current.masterSalt);
    if (computed !== current.masterHash) {
      return { ok: false, error: "主密码错误" };
    }
    // 解密所有 key 后以明文落库，并清空主密码 hash
    const decrypted = await decryptAllKeys(current, password);
    const next = { ...decrypted, masterHash: null, masterSalt: null };
    await saveSettings(next);
    sessionPassword = null;
    set({ settings: next });
    return { ok: true };
  },
}));

export function useActiveProvider(): AIProvider | null {
  return useSettingsStore((s) => {
    if (!s.settings) return null;
    return (
      s.settings.providers.find((p) => p.id === s.settings!.activeProviderId) ??
      null
    );
  });
}

export function useActivePreset(): Preset | null {
  return useSettingsStore((s) => {
    if (!s.settings) return null;
    return (
      s.settings.presets.find((p) => p.id === s.settings!.activePresetId) ??
      null
    );
  });
}
