/**
 * Example: Using fetchArenaState and useArenaState
 * 
 * This file demonstrates how to use the real Soroban contract integration
 * for fetching arena state.
 */

'use client';

import { useState } from 'react';
import { fetchArenaState } from '@/shared-d/utils/stellar-transactions';
// Note: Update this import path based on your actual hook location
// import { useArenaState } from '@/hooks/arena/useArenaState';
import { useArenaState } from '../src/hooks/arena/useArenaState';

/**
 * Example 1: Direct function call
 */
export function DirectFetchExample() {
  const [arenaId, setArenaId] = useState('');
  const [userAddress, setUserAddress] = useState('');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleFetch = async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const state = await fetchArenaState(
        arenaId,
        userAddress || undefined
      );
      setResult(state);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 border rounded">
      <h2 className="text-xl font-bold mb-4">Direct Fetch Example</h2>
      
      <div className="space-y-2 mb-4">
        <input
          type="text"
          placeholder="Arena Contract ID (C...)"
          value={arenaId}
          onChange={(e) => setArenaId(e.target.value)}
          className="w-full p-2 border rounded"
        />
        
        <input
          type="text"
          placeholder="User Address (optional, G...)"
          value={userAddress}
          onChange={(e) => setUserAddress(e.target.value)}
          className="w-full p-2 border rounded"
        />
        
        <button
          onClick={handleFetch}
          disabled={loading || !arenaId}
          className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50"
        >
          {loading ? 'Fetching...' : 'Fetch Arena State'}
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-100 text-red-700 rounded mb-4">
          Error: {error}
        </div>
      )}

      {result && (
        <div className="p-3 bg-green-100 rounded">
          <h3 className="font-bold mb-2">Arena State:</h3>
          <pre className="text-sm overflow-auto">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * Example 2: Using the hook with auto-refresh
 */
export function HookExample() {
  const [arenaId, setArenaId] = useState('');
  const [userAddress, setUserAddress] = useState('');
  const [enabled, setEnabled] = useState(false);

  const { arenaState, loading, error, refetch } = useArenaState(
    enabled ? arenaId : '',
    enabled ? userAddress || undefined : undefined,
    { refreshInterval: 5000 } // Refresh every 5 seconds
  );

  return (
    <div className="p-4 border rounded">
      <h2 className="text-xl font-bold mb-4">Hook Example (Auto-refresh)</h2>
      
      <div className="space-y-2 mb-4">
        <input
          type="text"
          placeholder="Arena Contract ID (C...)"
          value={arenaId}
          onChange={(e) => setArenaId(e.target.value)}
          className="w-full p-2 border rounded"
        />
        
        <input
          type="text"
          placeholder="User Address (optional, G...)"
          value={userAddress}
          onChange={(e) => setUserAddress(e.target.value)}
          className="w-full p-2 border rounded"
        />
        
        <div className="flex gap-2">
          <button
            onClick={() => setEnabled(!enabled)}
            disabled={!arenaId}
            className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50"
          >
            {enabled ? 'Stop Polling' : 'Start Polling'}
          </button>
          
          <button
            onClick={refetch}
            disabled={!enabled || loading}
            className="px-4 py-2 bg-gray-500 text-white rounded disabled:opacity-50"
          >
            Refresh Now
          </button>
        </div>
      </div>

      {loading && (
        <div className="p-3 bg-blue-100 text-blue-700 rounded mb-4">
          Loading arena state...
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-100 text-red-700 rounded mb-4">
          Error: {error}
        </div>
      )}

      {arenaState && (
        <div className="space-y-3">
          <div className="p-3 bg-green-100 rounded">
            <h3 className="font-bold mb-2">Arena State (Auto-updating):</h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>Arena ID:</div>
              <div className="font-mono text-xs">{arenaState.arenaId}</div>
              
              <div>Survivors:</div>
              <div>{arenaState.survivorCount} / {arenaState.maxCapacity}</div>
              
              <div>Round:</div>
              <div>{arenaState.roundNumber}</div>
              
              <div>Game State:</div>
              <div className="font-bold">{arenaState.gameState}</div>
              
              <div>Current Stake:</div>
              <div>{arenaState.currentStake} XLM</div>
              
              <div>Potential Payout:</div>
              <div>{arenaState.potentialPayout} XLM</div>
              
              <div>User In Arena:</div>
              <div>{arenaState.isUserIn ? '✅ Yes' : '❌ No'}</div>
              
              <div>Has Won:</div>
              <div>{arenaState.hasWon ? '🏆 Yes' : '❌ No'}</div>
            </div>
          </div>
          
          <div className="text-xs text-gray-500">
            Auto-refreshing every 5 seconds...
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Example 3: Arena Dashboard Component
 */
export function ArenaDashboard({ arenaId, userAddress }: { 
  arenaId: string; 
  userAddress?: string;
}) {
  const { arenaState, loading, error } = useArenaState(arenaId, userAddress);

  if (loading && !arenaState) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded">
        <h3 className="text-red-800 font-bold mb-2">Failed to load arena</h3>
        <p className="text-red-600 text-sm">{error}</p>
      </div>
    );
  }

  if (!arenaState) {
    return null;
  }

  const progressPercent = (arenaState.survivorCount / arenaState.maxCapacity) * 100;

  return (
    <div className="p-6 bg-white rounded-lg shadow-lg">
      <div className="flex justify-between items-start mb-6">
        <div>
          <h2 className="text-2xl font-bold">Arena #{arenaState.arenaId.slice(-8)}</h2>
          <p className="text-gray-600">Round {arenaState.roundNumber}</p>
        </div>
        <div className={`px-3 py-1 rounded-full text-sm font-bold ${
          arenaState.gameState === 'ACTIVE' ? 'bg-green-100 text-green-800' :
          arenaState.gameState === 'JOINING' ? 'bg-blue-100 text-blue-800' :
          arenaState.gameState === 'ENDED' ? 'bg-gray-100 text-gray-800' :
          'bg-yellow-100 text-yellow-800'
        }`}>
          {arenaState.gameState}
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span>Survivors</span>
            <span className="font-bold">
              {arenaState.survivorCount} / {arenaState.maxCapacity}
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="p-3 bg-gray-50 rounded">
            <div className="text-sm text-gray-600">Current Stake</div>
            <div className="text-xl font-bold">{arenaState.currentStake} XLM</div>
          </div>
          
          <div className="p-3 bg-gray-50 rounded">
            <div className="text-sm text-gray-600">Potential Payout</div>
            <div className="text-xl font-bold text-green-600">
              {arenaState.potentialPayout} XLM
            </div>
          </div>
        </div>

        {userAddress && (
          <div className="p-4 bg-blue-50 border border-blue-200 rounded">
            <h3 className="font-bold mb-2">Your Status</h3>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span>In Arena:</span>
                <span className="font-bold">
                  {arenaState.isUserIn ? '✅ Active' : '❌ Not participating'}
                </span>
              </div>
              {arenaState.hasWon && (
                <div className="flex justify-between">
                  <span>Status:</span>
                  <span className="font-bold text-green-600">🏆 Winner!</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Example 4: Complete page with all examples
 */
export default function ArenaStateExamplesPage() {
  return (
    <div className="container mx-auto p-8 space-y-8">
      <div>
        <h1 className="text-3xl font-bold mb-2">Arena State Integration Examples</h1>
        <p className="text-gray-600">
          Examples demonstrating the real Soroban contract integration for arena state.
        </p>
      </div>

      <DirectFetchExample />
      <HookExample />
      
      <div className="p-4 border rounded">
        <h2 className="text-xl font-bold mb-4">Dashboard Example</h2>
        <p className="text-sm text-gray-600 mb-4">
          Replace with a real arena contract ID to see the dashboard in action.
        </p>
        <ArenaDashboard 
          arenaId="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
          userAddress="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
        />
      </div>
    </div>
  );
}
