export interface NetworkStats {
  globalPoolTotal: number;
  liveSurvivors: number;
  networkLoad: 'low' | 'medium' | 'high';
  gasPrice: number;
  gasCurrency: string;
}

const randomVariation = (base: number, variance: number) => {
  return base + (Math.random() - 0.5) * variance;
};

export async function fetchNetworkStats({ signal }: { signal: AbortSignal }): Promise<NetworkStats> {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, 300);
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(new Error('AbortError'));
    });
  });

  const loads: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];
  const randomLoad = loads[Math.floor(Math.random() * loads.length)];

  return {
    globalPoolTotal: Math.round(randomVariation(1429082, 50000)),
    liveSurvivors: Math.round(randomVariation(12842, 500)),
    networkLoad: randomLoad,
    gasPrice: Math.round(randomVariation(10.5, 5) * 10) / 10,
    gasCurrency: 'GWEI',
  };
}
