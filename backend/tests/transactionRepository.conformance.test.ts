import { afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { TransactionModel } from '../src/db/models/transaction.model';
import { InMemoryTransactionRepository } from '../src/repositories/inMemoryTransactionRepository';
import { MongoTransactionRepository } from '../src/repositories/mongoTransactionRepository';
import type { TransactionRecord } from '../src/types/payment';

const memory = new InMemoryTransactionRepository();
const mongo = new MongoTransactionRepository();
const record = (id: string, overrides: Partial<TransactionRecord> = {}): TransactionRecord => ({
  id,
  payoutId: `payout-${id}`,
  idempotencyKey: `idem-${id}`,
  sourceAccount: `source-${id}`,
  destinationAccount: `destination-${id}`,
  asset: 'XLM',
  amountStroops: '10000000',
  nonce: 1,
  status: 'queued',
  unsignedXdr: 'unsigned-xdr',
  attempts: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const implementations = [
  ['memory', () => memory],
  ['mongo', () => mongo],
] as const;

beforeAll(async () => {
  await TransactionModel.init();
});

afterEach(async () => {
  await TransactionModel.deleteMany({});
});

describe.each(implementations)('%s TransactionRepository capabilities', (_name, createRepository) => {
  it('supports ID, idempotency-key, payout-ID, update and status lookups', async () => {
    const repository = createRepository();
    const item = record(`${_name}-1`);
    await repository.insert(item);

    expect(await repository.findById(item.id)).toMatchObject({ id: item.id });
    expect(await repository.findByIdempotencyKey(item.idempotencyKey)).toMatchObject({ id: item.id });
    expect(await repository.findByPayoutId(item.payoutId)).toMatchObject({ id: item.id });
    expect(await repository.listByStatus(['queued'], 10)).toHaveLength(1);
    expect(await repository.listByStatus(['failed'], 10)).toHaveLength(0);

    const updated = await repository.update(item.id, { status: 'confirmed', txHash: 'hash-1' });
    expect(updated).toMatchObject({ status: 'confirmed', txHash: 'hash-1' });
    expect(await repository.listByStatus(['confirmed'], 10)).toHaveLength(1);
  });

  it('rejects duplicate payout, idempotency, and source nonce reservations', async () => {
    const repository = createRepository();
    const item = record(`${_name}-base`);
    await repository.insert(item);

    await expect(repository.insert(record(`${_name}-same-payout`, {
      payoutId: item.payoutId,
      sourceAccount: 'other-source',
    }))).rejects.toThrow();
    await expect(repository.insert(record(`${_name}-same-idempotency`, {
      idempotencyKey: item.idempotencyKey,
      sourceAccount: 'other-source',
    }))).rejects.toThrow();
    await expect(repository.insert(record(`${_name}-same-nonce`, {
      sourceAccount: item.sourceAccount,
    }))).rejects.toThrow();
  });
});

describe('TransactionRepository nonce capability', () => {
  it('reserves strictly increasing nonces for concurrent in-memory requests', async () => {
    const repository = new InMemoryTransactionRepository();
    const nonces = await Promise.all(Array.from({ length: 20 }, () => repository.reserveNextNonce('wallet')));
    expect(new Set(nonces).size).toBe(20);
    expect(nonces.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('reserves distinct nonces for concurrent Mongo requests', async () => {
    const nonces = await Promise.all(Array.from({ length: 20 }, () => mongo.reserveNextNonce('wallet-concurrent')));
    expect(new Set(nonces).size).toBe(20);
  });
});
