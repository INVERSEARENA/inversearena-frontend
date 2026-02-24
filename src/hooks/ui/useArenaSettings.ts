"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const STORAGE_KEY = "arena_settings";

export type ArenaColorMode = "DARK_MODE" | "HIGH_CONTRAST_TERMINAL";

export interface ArenaSettings {
  masterVolume: number;
  effectsVolume: number;
  musicStream: boolean;
  voiceComm: boolean;
  energyPulse: boolean;
  colorMode: ArenaColorMode;
  hudOpacity: number;
}

export const DEFAULT_SETTINGS: ArenaSettings = {
  masterVolume: 80,
  effectsVolume: 70,
  musicStream: true,
  voiceComm: false,
  energyPulse: true,
  colorMode: "DARK_MODE",
  hudOpacity: 90,
};

function clampPercent(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function normalizeColorMode(value: unknown): ArenaColorMode {
  return value === "HIGH_CONTRAST_TERMINAL" ? value : "DARK_MODE";
}

function normalizeSettings(value: unknown): ArenaSettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS };

  const obj = value as Partial<Record<keyof ArenaSettings, unknown>>;

  return {
    masterVolume: clampPercent(obj.masterVolume, DEFAULT_SETTINGS.masterVolume),
    effectsVolume: clampPercent(
      obj.effectsVolume,
      DEFAULT_SETTINGS.effectsVolume,
    ),
    musicStream:
      typeof obj.musicStream === "boolean"
        ? obj.musicStream
        : DEFAULT_SETTINGS.musicStream,
    voiceComm:
      typeof obj.voiceComm === "boolean"
        ? obj.voiceComm
        : DEFAULT_SETTINGS.voiceComm,
    energyPulse:
      typeof obj.energyPulse === "boolean"
        ? obj.energyPulse
        : DEFAULT_SETTINGS.energyPulse,
    colorMode: normalizeColorMode(obj.colorMode),
    hudOpacity: clampPercent(obj.hudOpacity, DEFAULT_SETTINGS.hudOpacity),
  };
}

function shallowEqualSettings(a: ArenaSettings, b: ArenaSettings): boolean {
  return (
    a.masterVolume === b.masterVolume &&
    a.effectsVolume === b.effectsVolume &&
    a.musicStream === b.musicStream &&
    a.voiceComm === b.voiceComm &&
    a.energyPulse === b.energyPulse &&
    a.colorMode === b.colorMode &&
    a.hudOpacity === b.hudOpacity
  );
}

export function useArenaSettings() {
  const [settings, setSettings] = useState<ArenaSettings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const savedSnapshotRef = useRef<ArenaSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const defaults = { ...DEFAULT_SETTINGS };
        setSettings(defaults);
        savedSnapshotRef.current = defaults;
        return;
      }

      const parsed = JSON.parse(raw);
      const normalized = normalizeSettings(parsed);
      setSettings(normalized);
      savedSnapshotRef.current = normalized;
    } catch (error) {
      console.warn(
        "[useArenaSettings] Failed to read settings from localStorage. Falling back to defaults.",
        error,
      );
      const defaults = { ...DEFAULT_SETTINGS };
      setSettings(defaults);
      savedSnapshotRef.current = defaults;
    } finally {
      setHydrated(true);
      setIsDirty(false);
    }
  }, []);

  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      savedSnapshotRef.current = settings;
      setIsDirty(false);
    } catch (error) {
      console.warn(
        "[useArenaSettings] Failed to persist settings to localStorage.",
        error,
      );
      setIsDirty(!shallowEqualSettings(settings, savedSnapshotRef.current));
    }
  }, [hydrated, settings]);

  const updateSetting = useCallback(
    <K extends keyof ArenaSettings>(key: K, value: ArenaSettings[K]) => {
      setSettings((prev) => {
        const next = normalizeSettings({ ...prev, [key]: value });
        return next;
      });
    },
    [],
  );

  const resetDefaults = useCallback(() => {
    setSettings({ ...DEFAULT_SETTINGS });
  }, []);

  useEffect(() => {
    setIsDirty(!shallowEqualSettings(settings, savedSnapshotRef.current));
  }, [settings]);

  return useMemo(
    () => ({
      settings,
      updateSetting,
      resetDefaults,
      isDirty,
    }),
    [settings, updateSetting, resetDefaults, isDirty],
  );
}
