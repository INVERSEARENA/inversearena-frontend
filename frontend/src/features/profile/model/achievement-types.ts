// Player achievements model — #1726
// Definitions are versioned; changing criteria increments the version.
// The backend engine evaluates these idempotently from outbox/projection events.

export const ACHIEVEMENT_DEFINITIONS_VERSION = "1.0.0";

export type AchievementTier = "bronze" | "silver" | "gold" | "platinum";

export interface AchievementDefinition {
  id: string;
  title: string;
  description: string;
  tier: AchievementTier;
  /** Criteria expressed as a human-readable label; engine logic lives server-side */
  criteria: string;
}

export interface PlayerAchievement {
  definitionId: string;
  unlockedAt: string; // ISO timestamp
  arenaId?: string;   // source arena, if applicable
}

/** Canonical achievement catalogue — single source of truth on the client. */
export const ACHIEVEMENTS: AchievementDefinition[] = [
  {
    id: "first_win",
    title: "First Blood",
    description: "Win your first arena",
    tier: "bronze",
    criteria: "arena_won >= 1",
  },
  {
    id: "survivor_5",
    title: "Ironclad",
    description: "Survive 5 rounds in a single arena",
    tier: "silver",
    criteria: "rounds_survived_in_one_arena >= 5",
  },
  {
    id: "lone_minority_survivor",
    title: "Lone Wolf",
    description: "Be the last survivor from a minority cohort",
    tier: "gold",
    criteria: "lone_minority_survivor = true",
  },
  {
    id: "joined_10",
    title: "Veteran",
    description: "Join 10 arenas",
    tier: "bronze",
    criteria: "arenas_joined >= 10",
  },
  {
    id: "win_streak_3",
    title: "On Fire",
    description: "Win 3 arenas in a row",
    tier: "silver",
    criteria: "consecutive_wins >= 3",
  },
  {
    id: "joined_50",
    title: "Arena Legend",
    description: "Join 50 arenas",
    tier: "gold",
    criteria: "arenas_joined >= 50",
  },
  {
    id: "zero_disputes",
    title: "Clean Slate",
    description: "Complete 20 arenas without a dispute",
    tier: "silver",
    criteria: "arenas_completed >= 20 AND disputes = 0",
  },
  {
    id: "big_pot_win",
    title: "High Roller",
    description: "Win an arena with a pot over 10,000",
    tier: "platinum",
    criteria: "won_arena_with_pot >= 10000",
  },
];

export function getAchievementById(id: string): AchievementDefinition | undefined {
  return ACHIEVEMENTS.find((a) => a.id === id);
}

const TIER_ORDER: Record<AchievementTier, number> = {
  bronze: 0, silver: 1, gold: 2, platinum: 3,
};

export function sortByTier(defs: AchievementDefinition[]): AchievementDefinition[] {
  return [...defs].sort((a, b) => TIER_ORDER[b.tier] - TIER_ORDER[a.tier]);
}
