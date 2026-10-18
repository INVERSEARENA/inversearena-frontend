export interface ArenaCreatedEvent {
    type: 'ArenaCreated';
    arenaId: string;
    creator: string;
    maxPlayers: number;
    entryFee: string;
    timestamp: number;
}

export interface PlayerJoinedEvent {
    type: 'PlayerJoined';
    arenaId: string;
    playerWallet: string;
    timestamp: number;
}

export interface RoundStartedEvent {
    type: 'RoundStarted';
    arenaId: string;
    roundNumber: number;
    timestamp: number;
}

export interface ChoiceSubmittedEvent {
    type: 'ChoiceSubmitted';
    arenaId: string;
    playerWallet: string;
    choice: number;
    roundNumber: number;
    timestamp: number;
}

export interface RoundResolvedEvent {
    type: 'RoundResolved';
    arenaId: string;
    roundNumber: number;
    winningChoice: number;
    timestamp: number;
}

export interface WinnersDeclaredEvent {
    type: 'WinnersDeclared';
    arenaId: string;
    winners: string[];
    timestamp: number;
}

export type ArenaDomainEvent =
    | ArenaCreatedEvent
    | PlayerJoinedEvent
    | RoundStartedEvent
    | ChoiceSubmittedEvent
    | RoundResolvedEvent
    | WinnersDeclaredEvent;
