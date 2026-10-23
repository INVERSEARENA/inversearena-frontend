import { test, describe } from 'node:test';
import assert from 'node:assert';
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { EVENT_DECODER_REGISTRY, parseArenaEvent, RawContractEvent } from './sorobanEventParser.js';

describe('SorobanEventParser', () => {
    test('registers decoders under the current schema version', () => {
        assert.ok(EVENT_DECODER_REGISTRY[1]);
        assert.equal(typeof EVENT_DECODER_REGISTRY[1]?.init, 'function');
        assert.equal(typeof EVENT_DECODER_REGISTRY[1]?.resolved, 'function');
    });

    test('preserves unknown events from future schema versions without throwing', () => {
        const rawEvent: RawContractEvent = {
            type: 'contract',
            id: 'event-future',
            contractId: 'CAV6XGB...',
            schemaVersion: 2,
            topic: [nativeToScVal('resolved', { type: 'symbol' }).toXDR('base64')],
            value: { xdr: nativeToScVal({ round: 1, winner: 'Heads' }).toXDR('base64') },
        };
        assert.equal(parseArenaEvent(rawEvent), null);
    });

    test('correctly parses a PlayerJoined event', () => {
        const mockPlayer = 'GBRPNBYBD7Y4E6BOSFCHX3DJSV7N37XYTFGPCI27SRK6A4NQX7N7C4ZZ';
        const mockContractId = 'CAV6XGB...';

        // Create mock topics
        const topics = [
            nativeToScVal('join', { type: 'symbol' }).toXDR('base64'),
            nativeToScVal(mockPlayer, { type: 'address' }).toXDR('base64')
        ];

        const valueXdr = nativeToScVal(2, { type: 'u32' }).toXDR('base64');

        const rawEvent: RawContractEvent = {
            type: 'contract',
            id: 'event-id-1',
            contractId: mockContractId,
            topic: topics,
            value: { xdr: valueXdr },
            ledgerCloseAt: '2026-02-23T18:00:00Z'
        };

        const parsed = parseArenaEvent(rawEvent);

        assert.notStrictEqual(parsed, null);
        if (parsed) {
            assert.strictEqual(parsed.type, 'PlayerJoined');
            assert.strictEqual(parsed.arenaId, mockContractId);
            assert.strictEqual((parsed as any).playerWallet, mockPlayer);
            assert.strictEqual(typeof parsed.timestamp, 'number');
        }
    });

    test('returns null for unknown events and warns', () => {
        const topics = [
            nativeToScVal('unknown_event', { type: 'symbol' }).toXDR('base64')
        ];

        const rawEvent: RawContractEvent = {
            type: 'contract',
            id: 'event-id-2',
            contractId: 'CAV...',
            topic: topics,
            value: { xdr: nativeToScVal(null).toXDR('base64') }
        };

        const parsed = parseArenaEvent(rawEvent);
        assert.strictEqual(parsed, null);
    });

    test('returns null for invalid XDR', () => {
        const rawEvent: RawContractEvent = {
            type: 'contract',
            id: 'event-id-3',
            contractId: 'CAV...',
            topic: ['invalid-base64'],
            value: { xdr: 'invalid-base64' }
        };

        const parsed = parseArenaEvent(rawEvent);
        assert.strictEqual(parsed, null);
    });
});
