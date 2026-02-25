/**
 * SSR-safe LocalStorage Manager
 * Handles JSON serialization/deserialization and guards against window undefined.
 */

export enum StorageKey {
  ARENA_SETTINGS = "arena_settings",
  ONBOARDING_COMPLETED = "onboarding_completed",
  HAS_STAKED = "has_staked",
}

export const localStorageManager = {
  getItem: <T>(key: string, fallback: T): T => {
    if (typeof window === "undefined") return fallback;
    try {
      const item = window.localStorage.getItem(key);
      return item ? (JSON.parse(item) as T) : fallback;
    } catch (error) {
      console.warn(`Error reading localStorage key "${key}":`, error);
      return fallback;
    }
  },

  setItem: <T>(key: string, value: T): void => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn(`Error writing localStorage key "${key}":`, error);
    }
  },

  removeItem: (key: string): void => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      console.warn(`Error removing localStorage key "${key}":`, error);
    }
  },

  clearArenaStorage: (): void => {
    if (typeof window === "undefined") return;
    try {
      Object.keys(window.localStorage).forEach((key) => {
        if (key.startsWith("arena_")) {
          window.localStorage.removeItem(key);
        }
      });
    } catch (error) {
      console.warn("Error clearing arena storage:", error);
    }
  },
};
