import { create } from "zustand";
import type { AIProvider, AppSettings, Preset } from "../types";
import { getSettings, saveSettings } from "../lib/db";

interface SettingsState {
  settings: AppSettings | null;
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  upsertProvider: (provider: AIProvider) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  setActiveProvider: (id: string | null) => Promise<void>;
  upsertPreset: (preset: Preset) => Promise<void>;
  removePreset: (id: string) => Promise<void>;
  setActivePreset: (id: string | null) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: null,
  loaded: false,

  async load() {
    const settings = await getSettings();
    set({ settings, loaded: true });
  },

  async update(patch) {
    const current = get().settings;
    if (!current) return;
    const next = { ...current, ...patch };
    await saveSettings(next);
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
    await saveSettings(next);
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
    await saveSettings(next);
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
