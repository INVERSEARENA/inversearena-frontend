import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import LeaderboardPage from '../page';
import { useLeaderboard } from '@/features/leaderboard';

// Mock the leaderboard hook
jest.mock('@/features/leaderboard', () => ({
    ...jest.requireActual('@/features/leaderboard'),
    useLeaderboard: jest.fn(),
    formatAgentId: jest.fn((id) => id.slice(0, 6)),
    formatCurrency: jest.fn((val) => `$${val}`),
}));

// Mock the components that might be too complex or use animations
jest.mock('@/components/modals/PoolCreationModal', () => ({
    PoolCreationModal: ({ isOpen, onClose, challengedSurvivor }: any) =>
        isOpen ? (
            <div data-testid="challenge-modal">
                <p>Challenging {challengedSurvivor?.agentId}</p>
                <button onClick={onClose}>Close</button>
            </div>
        ) : null
}));

describe('LeaderboardPage', () => {
    const mockSurvivors = [
        { id: '1', agentId: 'ADDR1', rank: 1, survivalStreak: 10, totalYield: 1000, arenasWon: 5 },
        { id: '2', agentId: 'ADDR2', rank: 2, survivalStreak: 8, totalYield: 800, arenasWon: 3 },
        { id: '3', agentId: 'ADDR3', rank: 3, survivalStreak: 6, totalYield: 600, arenasWon: 2 },
        { id: '4', agentId: 'ADDR4', rank: 4, survivalStreak: 4, totalYield: 400, arenasWon: 1 },
        { id: '5', agentId: 'ADDR5', rank: 5, survivalStreak: 2, totalYield: 200, arenasWon: 0 },
        { id: '6', agentId: 'ADDR6', rank: 6, survivalStreak: 1, totalYield: 100, arenasWon: 0 },
        { id: '7', agentId: 'ADDR7', rank: 7, survivalStreak: 1, totalYield: 50, arenasWon: 0 },
        { id: '8', agentId: 'ADDR8', rank: 8, survivalStreak: 0, totalYield: 20, arenasWon: 0 },
        { id: '9', agentId: 'ADDR9', rank: 9, survivalStreak: 0, totalYield: 10, arenasWon: 0 },
        { id: '10', agentId: 'ADDR10', rank: 10, survivalStreak: 0, totalYield: 5, arenasWon: 0 },
        { id: '11', agentId: 'ADDR11', rank: 11, survivalStreak: 0, totalYield: 0, arenasWon: 0 },
    ];

    beforeEach(() => {
        jest.clearAllMocks();
        (useLeaderboard as jest.Mock).mockReturnValue({
            survivors: mockSurvivors,
            loading: false,
            error: null,
        });
        // Fast-forward initial loading timer
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('renders podium and table correctly', async () => {
        render(<LeaderboardPage />);

        act(() => {
            jest.advanceTimersByTime(1100);
        });

        // Check podium ranks
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
        expect(screen.getByText('#3')).toBeInTheDocument();

        // Check first person in the table (rank 4)
        expect(screen.getByText('ADDR4')).toBeInTheDocument();
    });

    it('handles pagination', async () => {
        render(<LeaderboardPage />);

        act(() => {
            jest.advanceTimersByTime(1100);
        });

        // Initial page shows Rank 4 to 10 (7 items per page as defined in page.tsx)
        expect(screen.getByText('ADDR4')).toBeInTheDocument();
        expect(screen.queryByText('ADDR11')).not.toBeInTheDocument();

        // Click next page
        const nextButton = screen.getByRole('button', { name: /2/i }); // Pagination button for page 2
        fireEvent.click(nextButton);

        expect(screen.getByText('ADDR11')).toBeInTheDocument();
        expect(screen.queryByText('ADDR4')).not.toBeInTheDocument();
    });

    it('opens challenge modal when challenge button is clicked', async () => {
        render(<LeaderboardPage />);

        act(() => {
            jest.advanceTimersByTime(1100);
        });

        const challengeButtons = screen.getAllByRole('button', { name: /challenge/i });
        fireEvent.click(challengeButtons[0]); // Challenge Rank 4

        expect(screen.getByTestId('challenge-modal')).toBeInTheDocument();
        expect(screen.getByText(/Challenging ADDR4/i)).toBeInTheDocument();

        // Close modal
        fireEvent.click(screen.getByText(/Close/i));
        expect(screen.queryByTestId('challenge-modal')).not.toBeInTheDocument();
    });

    it('renders error state from hook', async () => {
        const errorMsg = 'Failed to load survivors';
        (useLeaderboard as jest.Mock).mockReturnValue({
            survivors: [],
            loading: false,
            error: errorMsg,
        });

        render(<LeaderboardPage />);

        act(() => {
            jest.advanceTimersByTime(1100);
        });

        expect(screen.getByText(errorMsg)).toBeInTheDocument();
    });
});
