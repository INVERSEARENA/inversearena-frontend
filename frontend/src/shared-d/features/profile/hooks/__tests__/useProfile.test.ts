import { renderHook, waitFor, act } from '@testing-library/react';
import { useProfile } from '../useProfile';
import { profileRepository } from '../../data/profileRepository';

// Mock the repository
jest.mock('../../data/profileRepository', () => ({
    profileRepository: {
        getAgentIdentity: jest.fn(),
        getProfileStats: jest.fn(),
        getMyArenas: jest.fn(),
        getHistory: jest.fn(),
    },
    handleRepositoryError: jest.fn((err) => ({ message: err.message || 'Error' })),
}));

describe('useProfile', () => {
    const mockAddress = 'GBRPNBYBD7Y4E6BOSFCHX3DJSV7N37XYTFGPCI27SRK6A4NQX7N7C4ZZ';

    const mockIdentity = { id: 'INV-123', rank: 5, level: 10, survivalTime: 3600 };
    const mockStats = { totalStake: 1000, yieldEarned: 50, arenasCreated: 2 };
    const mockArenas = [{ id: 'arena-1', name: 'Arena 1', status: 'live' }];
    const mockHistory = [{ id: 'history-1', action: 'Join', timestamp: Date.now() }];

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should start with loading status', async () => {
        (profileRepository.getAgentIdentity as jest.Mock).mockReturnValue(new Promise(() => { }));
        (profileRepository.getProfileStats as jest.Mock).mockReturnValue(new Promise(() => { }));
        (profileRepository.getMyArenas as jest.Mock).mockReturnValue(new Promise(() => { }));
        (profileRepository.getHistory as jest.Mock).mockReturnValue(new Promise(() => { }));

        const { result } = renderHook(() => useProfile({ address: mockAddress }));

        expect(result.current.status).toBe('loading');
    });

    it('should fetch profile data successfully', async () => {
        (profileRepository.getAgentIdentity as jest.Mock).mockResolvedValue(mockIdentity);
        (profileRepository.getProfileStats as jest.Mock).mockResolvedValue(mockStats);
        (profileRepository.getMyArenas as jest.Mock).mockResolvedValue(mockArenas);
        (profileRepository.getHistory as jest.Mock).mockResolvedValue(mockHistory);

        const { result } = renderHook(() => useProfile({ address: mockAddress }));

        await waitFor(() => {
            expect(result.current.status).toBe('success');
        });

        expect(result.current.profile.identity).toEqual(mockIdentity);
        expect(result.current.profile.stats).toEqual(mockStats);
        expect(result.current.myArenas).toEqual(mockArenas);
        expect(result.current.history).toEqual(mockHistory);
    });

    it('should handle errors correctly', async () => {
        const errorMsg = 'Failed to fetch identity';
        (profileRepository.getAgentIdentity as jest.Mock).mockRejectedValue(new Error(errorMsg));
        (profileRepository.getProfileStats as jest.Mock).mockResolvedValue(mockStats);
        (profileRepository.getMyArenas as jest.Mock).mockResolvedValue(mockArenas);
        (profileRepository.getHistory as jest.Mock).mockResolvedValue(mockHistory);

        const { result } = renderHook(() => useProfile({ address: mockAddress }));

        await waitFor(() => {
            expect(result.current.status).toBe('error');
        });

        expect(result.current.error).toBe(errorMsg);
    });

    it('should refetch data when requested', async () => {
        (profileRepository.getAgentIdentity as jest.Mock).mockResolvedValue(mockIdentity);
        (profileRepository.getProfileStats as jest.Mock).mockResolvedValue(mockStats);
        (profileRepository.getMyArenas as jest.Mock).mockResolvedValue(mockArenas);
        (profileRepository.getHistory as jest.Mock).mockResolvedValue(mockHistory);

        const { result } = renderHook(() => useProfile({ address: mockAddress }));

        await waitFor(() => expect(result.current.status).toBe('success'));

        // Trigger refetch
        await result.current.refetch();

        expect(profileRepository.getAgentIdentity).toHaveBeenCalledTimes(2);
    });

    it('should update arenas when filter changes', async () => {
        (profileRepository.getAgentIdentity as jest.Mock).mockResolvedValue(mockIdentity);
        (profileRepository.getProfileStats as jest.Mock).mockResolvedValue(mockStats);
        (profileRepository.getMyArenas as jest.Mock).mockResolvedValue(mockArenas);
        (profileRepository.getHistory as jest.Mock).mockResolvedValue(mockHistory);

        const { result } = renderHook(() => useProfile({ address: mockAddress }));

        await waitFor(() => expect(result.current.status).toBe('success'));

        const newArenas = [{ id: 'arena-2', name: 'Arena 2', status: 'live' }];
        (profileRepository.getMyArenas as jest.Mock).mockResolvedValue(newArenas);

        act(() => {
            result.current.setMyArenasFilter('live');
        });

        await waitFor(() => {
            expect(result.current.myArenas).toEqual(newArenas);
        });

        expect(profileRepository.getMyArenas).toHaveBeenCalledWith(mockAddress, 'live');
    });
});
