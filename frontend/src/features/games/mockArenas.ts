import { Arena } from './types';

export const mockArenas: Arena[] = [
    {
        id: '1',
        number: '#842',
        playersJoined: 45,
        maxPlayers: 100,
        roundSpeed: '1 MIN',
        stake: '50 USDC',
        poolYield: '+8.4% APY',
        status: 'ACTIVE',
        isFeatured: true
    },
    {
        id: '2',
        number: '#843',
        playersJoined: 12,
        maxPlayers: 50,
        roundSpeed: '2 MIN',
        stake: '100 USDC',
        poolYield: '+9.1% APY',
        status: 'ACTIVE'
    },
    {
        id: '3',
        number: '#844',
        badge: 'STABLE',
        playersJoined: 88,
        maxPlayers: 100,
        roundSpeed: '5 MIN',
        stake: '10 USDC',
        poolYield: '+5.2% APY',
        status: 'ACTIVE'
    },
    {
        id: '4',
        number: '#845',
        badge: 'WHALE',
        playersJoined: 8,
        maxPlayers: 20,
        roundSpeed: '3 MIN',
        stake: '1000 USDC',
        poolYield: '+12.5% APY',
        status: 'ACTIVE'
    },
    {
        id: '5',
        number: '#846',
        badge: 'BLITZ',
        playersJoined: 42,
        maxPlayers: 60,
        roundSpeed: '30 SEC',
        stake: '25 USDC',
        poolYield: '+15.2% APY',
        status: 'ACTIVE'
    }
];
