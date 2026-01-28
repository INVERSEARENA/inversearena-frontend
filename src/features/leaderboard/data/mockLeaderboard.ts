import { Survivor } from '../types';

// Mock survivors for the rankings table
export const mockRankedSurvivors: Survivor[] = [
  {
    id: 'survivor-4',
    agentId: 'GBZXQ5T9PLMNBVCXZASDFGHJKLPOIUYTREWQ5T9PL',
    rank: 4,
    survivalStreak: 12,
    totalYield: 750.00,
    arenasWon: 5,
  },
  {
    id: 'survivor-5',
    agentId: 'GDRN3Z1QWERTYUIOPASDFGHJKLZXCVBNM3Z1QWERT',
    rank: 5,
    survivalStreak: 10,
    totalYield: 620.45,
    arenasWon: 4,
  },
  {
    id: 'survivor-6',
    agentId: 'GCZT9L0ASDFGHJKLPOIUYTREWQZXCVBNMT9L0ASDF',
    rank: 6,
    survivalStreak: 9,
    totalYield: 510.10,
    arenasWon: 3,
  },
  {
    id: 'survivor-7',
    agentId: 'GBXW2P4ZXCVBNMASDFGHJKLPOIUYTREWQW2P4ZXCV',
    rank: 7,
    survivalStreak: 7,
    totalYield: 435.50,
    arenasWon: 2,
  },
  {
    id: 'survivor-8',
    agentId: 'GDKM8R3POIUYTREWQASDFGHJKLZXCVBNM8R3POIUY',
    rank: 8,
    survivalStreak: 6,
    totalYield: 380.25,
    arenasWon: 2,
  },
  {
    id: 'survivor-9',
    agentId: 'GCPL5V7ASDFGHJKLPOIUYTREWQZXCVBNML5V7ASDF',
    rank: 9,
    survivalStreak: 5,
    totalYield: 320.80,
    arenasWon: 2,
  },
  {
    id: 'survivor-10',
    agentId: 'GBTN4Q6ZXCVBNMASDFGHJKLPOIUYTREWQN4Q6ZXCV',
    rank: 10,
    survivalStreak: 5,
    totalYield: 290.00,
    arenasWon: 1,
  },
  {
    id: 'survivor-11',
    agentId: 'GDWK9S2POIUYTREWQASDFGHJKLZXCVBNMK9S2POIU',
    rank: 11,
    survivalStreak: 4,
    totalYield: 265.40,
    arenasWon: 1,
  },
  {
    id: 'survivor-12',
    agentId: 'GCRF7X1ASDFGHJKLPOIUYTREWQZXCVBNMF7X1ASDF',
    rank: 12,
    survivalStreak: 4,
    totalYield: 240.15,
    arenasWon: 1,
  },
  {
    id: 'survivor-13',
    agentId: 'GBYL3M8ZXCVBNMASDFGHJKLPOIUYTREWQL3M8ZXCV',
    rank: 13,
    survivalStreak: 3,
    totalYield: 215.90,
    arenasWon: 1,
  },
  {
    id: 'survivor-14',
    agentId: 'GDHN6P5POIUYTREWQASDFGHJKLZXCVBNMN6P5POIU',
    rank: 14,
    survivalStreak: 3,
    totalYield: 195.25,
    arenasWon: 1,
  },
  {
    id: 'survivor-15',
    agentId: 'GCQT2W9ASDFGHJKLPOIUYTREWQZXCVBNMT2W9ASDF',
    rank: 15,
    survivalStreak: 2,
    totalYield: 175.00,
    arenasWon: 0,
  },
  {
    id: 'survivor-16',
    agentId: 'GBMX8K4ZXCVBNMASDFGHJKLPOIUYTREWQX8K4ZXCV',
    rank: 16,
    survivalStreak: 2,
    totalYield: 158.50,
    arenasWon: 0,
  },
  {
    id: 'survivor-17',
    agentId: 'GDSL1R7POIUYTREWQASDFGHJKLZXCVBNML1R7POIU',
    rank: 17,
    survivalStreak: 2,
    totalYield: 142.30,
    arenasWon: 0,
  },
  {
    id: 'survivor-18',
    agentId: 'GCVN5Y3ASDFGHJKLPOIUYTREWQZXCVBNMN5Y3ASDF',
    rank: 18,
    survivalStreak: 1,
    totalYield: 128.00,
    arenasWon: 0,
  },
  {
    id: 'survivor-19',
    agentId: 'GBPW7T6ZXCVBNMASDFGHJKLPOIUYTREWQW7T6ZXCV',
    rank: 19,
    survivalStreak: 1,
    totalYield: 115.75,
    arenasWon: 0,
  },
  {
    id: 'survivor-20',
    agentId: 'GDKR4H2POIUYTREWQASDFGHJKLZXCVBNMR4H2POIU',
    rank: 20,
    survivalStreak: 1,
    totalYield: 105.20,
    arenasWon: 0,
  },
];

// Get paginated survivors for table display
export function getPaginatedSurvivors(
  page: number,
  itemsPerPage: number = 4
): Survivor[] {
  const startIndex = (page - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  return mockRankedSurvivors.slice(startIndex, endIndex);
}

// Calculate total pages
export function getTotalPages(itemsPerPage: number = 4): number {
  return Math.ceil(mockRankedSurvivors.length / itemsPerPage);
}

// Truncate agent ID for display (e.g. "G...X4Y2")
export function formatAgentId(agentId: string): string {
  if (agentId.length <= 8) return agentId;
  return `${agentId.charAt(0)}...${agentId.slice(-4)}`;
}

// Format as currency (e.g. "$750.00")
export function formatCurrency(value: number): string {
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
