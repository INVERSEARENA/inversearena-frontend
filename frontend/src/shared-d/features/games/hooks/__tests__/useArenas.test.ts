import { renderHook, waitFor, act } from '@testing-library/react';
import { useArenas } from '../useArenas';
import { arenasRepository } from '../../data/arenasRepository';

// Mock the repository
jest.mock('../../data/arenasRepository', () => ({
    arenasRepository: {
        getArenas: jest.fn(),
        getFeaturedArena: jest.fn(),
    },
    handleRepositoryError: jest.fn((err) => ({ message: err.message || 'Error' })),
    validateSearchQuery: jest.fn(() => true),
    normalizeSearchQuery: jest.fn((s) => s.trim().toLowerCase()),
}));

describe('useArenas', () => {
    const mockArenas = [
        { id: '1', displayId: 101, name: 'Arena One', status: 'active' },
        { id: '2', displayId: 102, name: 'Arena Two', status: 'active' },
    ];
    const mockFeatured = { id: '3', displayId: 103, name: 'Featured Arena', status: 'active' };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should start with loading status', async () => {
        (arenasRepository.getArenas as jest.Mock).mockReturnValue(new Promise(() => { }));
        (arenasRepository.getFeaturedArena as jest.Mock).mockReturnValue(new Promise(() => { }));

        const { result } = renderHook(() => useArenas());

        expect(result.current.status).toBe('loading');
    });

    it('should fetch arenas successfully', async () => {
        (arenasRepository.getArenas as jest.Mock).mockResolvedValue(mockArenas);
        (arenasRepository.getFeaturedArena as jest.Mock).mockResolvedValue(mockFeatured);

        const { result } = renderHook(() => useArenas());

        await waitFor(() => {
            expect(result.current.status).toBe('success');
        });

        expect(result.current.arenas).toEqual(mockArenas);
        expect(result.current.featuredArena).toEqual(mockFeatured);
        expect(result.current.totalCount).toBe(2);
    });

    it('should apply limit to arenas list', async () => {
        (arenasRepository.getArenas as jest.Mock).mockResolvedValue(mockArenas);
        (arenasRepository.getFeaturedArena as jest.Mock).mockResolvedValue(mockFeatured);

        const { result } = renderHook(() => useArenas({ limit: 1 }));

        await waitFor(() => expect(result.current.status).toBe('success'));

        expect(result.current.arenas).toHaveLength(1);
        expect(result.current.arenas[0].id).toBe('1');
    });

    it('should handle search queries', async () => {
        (arenasRepository.getArenas as jest.Mock).mockResolvedValue(mockArenas);
        (arenasRepository.getFeaturedArena as jest.Mock).mockResolvedValue(mockFeatured);

        const { result } = renderHook(() => useArenas());

        await waitFor(() => expect(result.current.status).toBe('success'));

        act(() => {
            result.current.setSearch('Test');
        });

        await waitFor(() => {
            expect(arenasRepository.getArenas).toHaveBeenLastCalledWith({
                filter: 'all',
                search: 'test',
            });
        });
    });

    it('should handle errors correctly', async () => {
        (arenasRepository.getArenas as jest.Mock).mockRejectedValue(new Error('Fetch failed'));
        (arenasRepository.getFeaturedArena as jest.Mock).mockResolvedValue(mockFeatured);

        const { result } = renderHook(() => useArenas());

        await waitFor(() => {
            expect(result.current.status).toBe('error');
        });

        expect(result.current.error).toBe('Fetch failed');
    });
});
