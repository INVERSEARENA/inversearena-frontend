import { PaymentService } from '../src/services/paymentService';
import { InMemoryTransactionRepository } from '../src/repositories/inMemoryTransactionRepository';
import type { PaymentConfig } from '../src/config/paymentConfig';

const mockConfig: PaymentConfig = {
  liveExecution: false,
  signWithHotKey: false,
  maxGasStroops: 2000000,
  maxAttempts: 5,
  confirmPollMs: 100,
  confirmMaxPolls: 3,
  payoutMethodName: 'distribute_winnings',
  payoutContractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
  sourceAccount: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
  hotSignerSecret: undefined,
  networkPassphrase: 'Test SDF Network ; September 2015',
  sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
};

async function testBuildOnlyFlow() {
  console.log('🧪 Test: Build-Only Flow');
  
  const transactions = new InMemoryTransactionRepository();
  const paymentService = new PaymentService(transactions, { config: mockConfig });

  const result = await paymentService.createPayoutTransaction({
    payoutId: 'test-payout-1',
    destinationAccount: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    amount: '100.5000000',
    asset: 'XLM',
    idempotencyKey: 'test:build-only:1',
  });

  const pass = 
    result.mode === 'build_only' &&
    result.transaction.status === 'built' &&
    result.unsignedXdr !== null &&
    result.transaction.signedXdr === null;

  console.log(pass ? '✅ PASS: Build-only mode works' : '❌ FAIL: Build-only mode failed');
  console.log('  Mode:', result.mode);
  console.log('  Status:', result.transaction.status);
  console.log('  Has unsigned XDR:', !!result.unsignedXdr);
}

async function testIdempotency() {
  console.log('\n🧪 Test: Idempotency');
  
  const transactions = new InMemoryTransactionRepository();
  const paymentService = new PaymentService(transactions, { config: mockConfig });

  const idempotencyKey = 'test:idempotency:unique-key-123';

  const result1 = await paymentService.createPayoutTransaction({
    payoutId: 'test-payout-2',
    destinationAccount: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    amount: '50.0000000',
    asset: 'XLM',
    idempotencyKey,
  });

  const result2 = await paymentService.createPayoutTransaction({
    payoutId: 'test-payout-3', // Different payout ID
    destinationAccount: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    amount: '75.0000000', // Different amount
    asset: 'XLM',
    idempotencyKey, // Same idempotency key
  });

  const pass = result1.transaction.id === result2.transaction.id;

  console.log(pass ? '✅ PASS: Idempotency works' : '❌ FAIL: Idempotency failed');
  console.log('  TX1 ID:', result1.transaction.id);
  console.log('  TX2 ID:', result2.transaction.id);
  console.log('  Same transaction:', pass);
}

async function testNonceTracking() {
  console.log('\n🧪 Test: Nonce Tracking');
  
  const transactions = new InMemoryTransactionRepository();
  const paymentService = new PaymentService(transactions, { config: mockConfig });

  const results = await Promise.all([
    paymentService.createPayoutTransaction({
      payoutId: 'nonce-test-1',
      destinationAccount: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      amount: '10.0000000',
      asset: 'XLM',
      idempotencyKey: 'nonce:1',
    }),
    paymentService.createPayoutTransaction({
      payoutId: 'nonce-test-2',
      destinationAccount: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      amount: '20.0000000',
      asset: 'XLM',
      idempotencyKey: 'nonce:2',
    }),
    paymentService.createPayoutTransaction({
      payoutId: 'nonce-test-3',
      destinationAccount: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      amount: '30.0000000',
      asset: 'XLM',
      idempotencyKey: 'nonce:3',
    }),
  ]);

  const nonces = results.map(r => r.transaction.nonce);
  const uniqueNonces = new Set(nonces);
  const sequential = nonces.every((n, i) => i === 0 || n > nonces[i - 1]);

  const pass = uniqueNonces.size === nonces.length && sequential;

  console.log(pass ? '✅ PASS: Nonce tracking works' : '❌ FAIL: Nonce tracking failed');
  console.log('  Nonces:', nonces);
  console.log('  All unique:', uniqueNonces.size === nonces.length);
  console.log('  Sequential:', sequential);
}

async function testInputValidation() {
  console.log('\n🧪 Test: Input Validation');
  
  const transactions = new InMemoryTransactionRepository();
  const paymentService = new PaymentService(transactions, { config: mockConfig });

  const tests = [
    {
      name: 'Invalid destination account',
      input: {
        payoutId: 'test',
        destinationAccount: 'INVALID',
        amount: '10.0000000',
        asset: 'XLM' as const,
        idempotencyKey: 'test:invalid:1',
      },
      shouldFail: true,
    },
    {
      name: 'Invalid amount format',
      input: {
        payoutId: 'test',
        destinationAccount: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
        amount: 'not-a-number',
        asset: 'XLM' as const,
        idempotencyKey: 'test:invalid:2',
      },
      shouldFail: true,
    },
    {
      name: 'Invalid idempotency key',
      input: {
        payoutId: 'test',
        destinationAccount: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
        amount: '10.0000000',
        asset: 'XLM' as const,
        idempotencyKey: 'bad key!@#',
      },
      shouldFail: true,
    },
  ];

  let passed = 0;
  for (const test of tests) {
    try {
      await paymentService.createPayoutTransaction(test.input);
      if (test.shouldFail) {
        console.log(`  ❌ ${test.name}: Should have failed`);
      } else {
        console.log(`  ✅ ${test.name}: Passed`);
        passed++;
      }
    } catch (error) {
      if (test.shouldFail) {
        console.log(`  ✅ ${test.name}: Correctly rejected`);
        passed++;
      } else {
        console.log(`  ❌ ${test.name}: Should not have failed`);
      }
    }
  }

  console.log(passed === tests.length ? '✅ PASS: All validations work' : '❌ FAIL: Some validations failed');
}

async function testAmountConversion() {
  console.log('\n🧪 Test: Amount to Stroops Conversion');
  
  const transactions = new InMemoryTransactionRepository();
  const paymentService = new PaymentService(transactions, { config: mockConfig });

  const testCases = [
    { amount: '1.0000000', expectedStroops: '10000000' },
    { amount: '0.0000001', expectedStroops: '1' },
    { amount: '100.5000000', expectedStroops: '1005000000' },
    { amount: '0.1234567', expectedStroops: '1234567' },
  ];

  let passed = 0;
  for (const test of testCases) {
    const result = await paymentService.createPayoutTransaction({
      payoutId: `amount-test-${test.amount}`,
      destinationAccount: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      amount: test.amount,
      asset: 'XLM',
      idempotencyKey: `amount:${test.amount}`,
    });

    if (result.transaction.amountStroops === test.expectedStroops) {
      console.log(`  ✅ ${test.amount} → ${test.expectedStroops} stroops`);
      passed++;
    } else {
      console.log(`  ❌ ${test.amount} → ${result.transaction.amountStroops} (expected ${test.expectedStroops})`);
    }
  }

  console.log(passed === testCases.length ? '✅ PASS: Amount conversion works' : '❌ FAIL: Amount conversion failed');
}

async function runTests() {
  console.log('🔍 Payment Service Test Suite');
  console.log('==============================\n');

  try {
    await testBuildOnlyFlow();
    await testIdempotency();
    await testNonceTracking();
    await testInputValidation();
    await testAmountConversion();
    
    console.log('\n✅ All tests completed');
  } catch (error) {
    console.error('\n❌ Test error:', error);
    process.exit(1);
  }
}

runTests();
