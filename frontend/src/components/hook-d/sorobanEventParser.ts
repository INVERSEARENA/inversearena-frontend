import { scValToNative, xdr } from '@stellar/stellar-sdk';
import {
    ArenaDomainEvent,
    ArenaCreatedEvent,
    PlayerJoinedEvent,
    RoundStartedEvent,
    ChoiceSubmittedEvent,
    RoundResolvedEvent,
    WinnersDeclaredEvent
} from '../../shared-d/types/arenaTypes';

/**
 * Minimal interface describing the shape of raw Soroban events from RPC/Horizon.
 */
export interface RawContractEvent {
    type: string;
    id: string;
    contractId: string;
    topic: string[]; // Array of base64 encoded ScVal XDR strings
    value: {
        xdr: string; // Base64 encoded ScVal XDR string
    };
    ledgerCloseAt?: string;
}

/**
 * Normalizes raw Stellar/Soroban contract events into strongly-typed arena domain objects.
 * @param raw - The raw event object from Stellar RPC or Horizon.
 * @returns A typed ArenaDomainEvent or null if the event is unrecognized or invalid.
 */
export function parseArenaEvent(raw: RawContractEvent): ArenaDomainEvent | null {
    try {
        if (!raw.topic || raw.topic.length === 0) return null;

        // The first topic is usually the event name as a symbol
        const eventNameScVal = xdr.ScVal.fromXDR(raw.topic[0]!, 'base64');
        const eventName = scValToNative(eventNameScVal);

        switch (eventName) {
            case 'arena_created':
                return parseArenaCreatedEvent(raw);
            case 'player_joined':
                return parsePlayerJoinedEvent(raw);
            case 'round_started':
                return parseRoundStartedEvent(raw);
            case 'choice_submitted':
                return parseChoiceSubmittedEvent(raw);
            case 'round_resolved':
                return parseRoundResolvedEvent(raw);
            case 'winners_declared':
                return parseWinnersDeclaredEvent(raw);
            default:
                console.warn(`[SorobanEventParser] Unknown event type detected: ${eventName}`, raw);
                return null;
        }
    } catch (error) {
        console.error('[SorobanEventParser] Failed to parse event', error, raw);
        return null;
    }
}

function parseArenaCreatedEvent(raw: RawContractEvent): ArenaCreatedEvent | null {
    const value = decodeValue(raw.value.xdr);
    if (!value) return null;

    return {
        type: 'ArenaCreated',
        arenaId: raw.contractId,
        creator: value.creator,
        maxPlayers: Number(value.max_players),
        entryFee: value.entry_fee.toString(),
        timestamp: getTimestamp(raw),
    };
}

function parsePlayerJoinedEvent(raw: RawContractEvent): PlayerJoinedEvent | null {
    const value = decodeValue(raw.value.xdr);
    if (!value) return null;

    return {
        type: 'PlayerJoined',
        arenaId: raw.contractId,
        playerWallet: value.player,
        timestamp: getTimestamp(raw),
    };
}

function parseRoundStartedEvent(raw: RawContractEvent): RoundStartedEvent | null {
    const value = decodeValue(raw.value.xdr);
    if (!value) return null;

    return {
        type: 'RoundStarted',
        arenaId: raw.contractId,
        roundNumber: Number(value.round),
        timestamp: getTimestamp(raw),
    };
}

function parseChoiceSubmittedEvent(raw: RawContractEvent): ChoiceSubmittedEvent | null {
    const value = decodeValue(raw.value.xdr);
    if (!value) return null;

    return {
        type: 'ChoiceSubmitted',
        arenaId: raw.contractId,
        playerWallet: value.player,
        choice: value.choice === 'Heads' ? 0 : 1,
        roundNumber: Number(value.round),
        timestamp: getTimestamp(raw),
    };
}

function parseRoundResolvedEvent(raw: RawContractEvent): RoundResolvedEvent | null {
    const value = decodeValue(raw.value.xdr);
    if (!value) return null;

    return {
        type: 'RoundResolved',
        arenaId: raw.contractId,
        roundNumber: Number(value.round),
        winningChoice: value.winner === 'Heads' ? 0 : 1,
        timestamp: getTimestamp(raw),
    };
}

function parseWinnersDeclaredEvent(raw: RawContractEvent): WinnersDeclaredEvent | null {
    const value = decodeValue(raw.value.xdr);
    if (!value) return null;

    return {
        type: 'WinnersDeclared',
        arenaId: raw.contractId,
        winners: Array.isArray(value.winners) ? value.winners : [],
        timestamp: getTimestamp(raw),
    };
}

/**
 * Helper to decode ScVal XDR to a native JS object/value.
 */
function decodeValue(xdrString: string): any {
    try {
        const scval = xdr.ScVal.fromXDR(xdrString, 'base64');
        return scValToNative(scval);
    } catch (error) {
        console.warn('[SorobanEventParser] Failed to decode value XDR', error);
        return null;
    }
}

/**
 * Extracts timestamp from ledgerCloseAt or defaults to now.
 */
function getTimestamp(raw: RawContractEvent): number {
    if (raw.ledgerCloseAt) {
        return new Date(raw.ledgerCloseAt).getTime();
    }
    return Date.now();
}
