"use client";

import { useState, useEffect, useCallback } from "react";
import { localStorageManager, StorageKey } from "../utils/localStorage";

export type ColorMode = "dark" | "high-contrast";

export interface ArenaSettings {
  masterVolume: number;
  effectsVolume: number;
  musicStream: boolean;
  voiceComm: boolean;
  energyPulse: boolean;
  colorMode: ColorMode;
  hudOpacity: number;
  notificationsEnabled: boolean;
}

const DEFAULT_SETTINGS: ArenaSettings = {
  masterVolume: 85,
  effectsVolume: 70,
  musicStream: true,
  voiceComm: false,
  energyPulse: true,
  colorMode: "dark",
  hudOpacity: 45,
  notificationsEnabled: true,
};

export function useArenaSettings() {
  const [settings, setSettings] = useState<ArenaSettings>(DEFAULT_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    const saved = localStorageManager.getItem<ArenaSettings>(
      StorageKey.ARENA_SETTINGS,
      DEFAULT_SETTINGS
    );
    setSettings(saved);
    setIsLoaded(true);
  }, []);

  // Update a single setting
  const updateSetting = useCallback(
    <K extends keyof ArenaSettings>(key: K, value: ArenaSettings[K]) => {
      setSettings((prev) => {
        const next = { ...prev, [key]: value };
        localStorageManager.setItem(StorageKey.ARENA_SETTINGS, next);
        return next;
      });
    },
    []
  );

  // Reset to defaults
  const resetDefaults = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    localStorageManager.setItem(StorageKey.ARENA_SETTINGS, DEFAULT_SETTINGS);
  }, []);

  return {
    settings,
    updateSetting,
    resetDefaults,
    isLoaded,
  };
}
