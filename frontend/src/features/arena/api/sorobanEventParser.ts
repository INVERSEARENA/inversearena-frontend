import { scValToNative, xdr } from '@stellar/stellar-sdk';
import {
    ArenaDomainEvent,
    ArenaCreatedEvent,
    PlayerJoinedEvent,
    PlayerJoinedSponsoredEvent,
    RoundStartedEvent,
    ChoiceSubmittedEvent,
    RoundResolvedEvent,
    WinnersDeclaredEvent,
    PlayerEliminatedEvent
} from '@/shared/lib/stellar/arenaTypes';

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
    /** Version of the event envelope/decoder contract. Legacy events are v1. */
    schemaVersion?: number;
}

type EventDecoder = (raw: RawContractEvent) => ArenaDomainEvent | null;

/** Keep decoder ownership explicit; new wire formats receive a new version. */
export const EVENT_DECODER_REGISTRY: Readonly<Record<number, Readonly<Record<string, EventDecoder>>>> = {
    1: {
        init: parseArenaCreatedEvent,
        join: parsePlayerJoinedEvent,
        join_spon: parsePlayerJoinedSponsoredEvent,
        started: parseRoundStartedEvent,
        commit: parseChoiceSubmittedEvent,
        reveal: parseChoiceRevealedEvent,
        resolved: parseRoundResolvedEvent,
        finished: parseWinnersDeclaredEvent,
        claimed: parsePrizeClaimedEvent,
        elim: parsePlayerEliminatedEvent,
        elim2: parsePlayerEliminatedEventV2,
    },
};

/**
 * Normalizes raw Stellar/Soroban contract events into strongly-typed arena domain objects.
 * @param raw - The raw event object from Stellar RPC or Horizon.
 * @returns A typed ArenaDomainEvent or null if the event is unrecognized or invalid.
 */
export function parseArenaEvent(raw: RawContractEvent): ArenaDomainEvent | null {
    try {
        if (!raw.topic || raw.topic.length === 0) return null;

        // #1607 events prepend an "arena" namespace before the event name.
        const namespaceOffset = getNamespaceOffset(raw);
        if (raw.topic.length <= namespaceOffset) return null;
        const eventNameScVal = xdr.ScVal.fromXDR(raw.topic[namespaceOffset]!, 'base64');
        const eventName = scValToNative(eventNameScVal);

        const version = raw.schemaVersion ?? 1;
        const decoder = EVENT_DECODER_REGISTRY[version]?.[String(eventName).toLowerCase()];
        if (!decoder) {
            console.warn(
                `[SorobanEventParser] Unknown event type or schema version: ${version}:${String(eventName)}`,
                raw,
            );
            return null;
        }
        return decoder(raw);
    } catch (error) {
        console.error('[SorobanEventParser] Failed to parse event', error, raw);
        return null;
    }
}

function parseArenaCreatedEvent(raw: RawContractEvent): ArenaCreatedEvent | null {
    // Admin address is in value (#1106)
    const value = decodeValue(raw.value.xdr);
    if (!value) return null;

    return {
        type: 'ArenaCreated',
        arenaId: raw.contractId,
        creator: value,
        maxPlayers: 0, // Not available in init event
        entryFee: "0", // Not available in init event
        timestamp: getTimestamp(raw),
    };
}

/** 1 when the event uses the normalized `("arena", name, ...)` topics (#1607). */
function getNamespaceOffset(raw: RawContractEvent): number {
    try {
        return scValToNative(xdr.ScVal.fromXDR(raw.topic[0]!, 'base64')) === 'arena' ? 1 : 0;
    } catch {
        return 0;
    }
}

function parsePlayerJoinedEvent(raw: RawContractEvent): PlayerJoinedEvent | null {
    // Player address follows the optional namespace, player_count is in value (#1106, #1607)
    const offset = getNamespaceOffset(raw);
    if (!raw.topic || raw.topic.length <= offset + 1) return null;

    const playerScVal = xdr.ScVal.fromXDR(raw.topic[offset + 1]!, 'base64');
    const player = scValToNative(playerScVal);

    const value = decodeValue(raw.value.xdr);
    if (!value) return null;

    return {
        type: 'PlayerJoined',
        arenaId: raw.contractId,
        playerWallet: player,
        timestamp: getTimestamp(raw),
    };
}

/** #1715: `join_spon` indexes payer then player, and carries the new roster size. */
function parsePlayerJoinedSponsoredEvent(raw: RawContractEvent): PlayerJoinedSponsoredEvent | null {
    const offset = getNamespaceOffset(raw);
    // `offset` points at the event name; payer/player follow it immediately.
    if (!raw.topic || raw.topic.length <= offset + 2) return null;

    const payer = scValToNative(xdr.ScVal.fromXDR(raw.topic[offset + 1]!, 'base64'));
    const player = scValToNative(xdr.ScVal.fromXDR(raw.topic[offset + 2]!, 'base64'));
    const value = decodeValue(raw.value.xdr);
    if (!value) return null;
    const playerCount = Number(Array.isArray(value) ? value[1] : value);

    return {
        type: 'PlayerJoinedSponsored',
        arenaId: raw.contractId,
        payerWallet: payer,
        playerWallet: player,
        playerCount: Number.isFinite(playerCount) ? playerCount : 0,
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
        choice: value.choice === 'Heads' ? 0 : value.choice === 'Tails' ? 1 : 2,
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
        winningChoice: value.winner === 'Heads' ? 0 : value.winner === 'Tails' ? 1 : 2,
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

function parseChoiceRevealedEvent(raw: RawContractEvent): ChoiceSubmittedEvent | null {
    // Player address is in topic[1], choice and round are in value (#1106)
    if (!raw.topic || raw.topic.length < 2) return null;
    
    const playerScVal = xdr.ScVal.fromXDR(raw.topic[1]!, 'base64');
    const player = scValToNative(playerScVal);
    
    const value = decodeValue(raw.value.xdr);
    if (!value) return null;

    return {
        type: 'ChoiceSubmitted',
        arenaId: raw.contractId,
        playerWallet: player,
        choice: value.choice === 'Heads' ? 0 : value.choice === 'Tails' ? 1 : 2,
        roundNumber: Number(value.round),
        timestamp: getTimestamp(raw),
    };
}

function parsePrizeClaimedEvent(raw: RawContractEvent): WinnersDeclaredEvent | null {
    // Winner address is in topic[1], amount and yield_amount are in value (#1106)
    if (!raw.topic || raw.topic.length < 2) return null;
    
    const winnerScVal = xdr.ScVal.fromXDR(raw.topic[1]!, 'base64');
    const winner = scValToNative(winnerScVal);
    
    const value = decodeValue(raw.value.xdr);
    if (!value) return null;

    return {
        type: 'WinnersDeclared',
        arenaId: raw.contractId,
        winners: [winner],
        timestamp: getTimestamp(raw),
    };
}

function parsePlayerEliminatedEvent(raw: RawContractEvent): PlayerEliminatedEvent | null {
    // Player address is in topic[1], round is in value (#1106)
    if (!raw.topic || raw.topic.length < 2) return null;
    
    const namespaced = scValToNative(xdr.ScVal.fromXDR(raw.topic[0]!, 'base64')) === 'arena';
    const playerScVal = xdr.ScVal.fromXDR(raw.topic[namespaced ? 2 : 1]!, 'base64');
    const player = scValToNative(playerScVal);
    
    const value = decodeValue(raw.value.xdr);
    if (!value) return null;

    return {
        type: 'PlayerEliminated',
        arenaId: raw.contractId,
        playerWallet: player,
        roundNumber: Number(Array.isArray(value) ? value[1] : value),
        reason: null,
        timestamp: getTimestamp(raw),
    };
}

function parsePlayerEliminatedEventV2(raw: RawContractEvent): PlayerEliminatedEvent | null {
    if (!raw.topic || raw.topic.length < 3) return null;
    const player = scValToNative(xdr.ScVal.fromXDR(raw.topic[2]!, 'base64'));
    const value = decodeValue(raw.value.xdr);
    if (!value) return null;
    const tuple = Array.isArray(value) ? value : null;
    const rawReason = tuple ? tuple[2] : value.reason;
    const names = ['Majority', 'NoReveal', 'NoCommit'];
    const reasonName = typeof rawReason === 'string'
        ? rawReason
        : rawReason && typeof rawReason === 'object'
            ? Object.keys(rawReason)[0]
            : undefined;
    const reason = reasonName && names.includes(reasonName)
        ? reasonName as PlayerEliminatedEvent['reason']
        : null;
    return {
        type: 'PlayerEliminated',
        arenaId: raw.contractId,
        playerWallet: player,
        roundNumber: Number(tuple ? tuple[1] : value.round),
        reason,
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
