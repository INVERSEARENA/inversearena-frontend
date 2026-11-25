import React from 'react';
import { screen } from '@testing-library/react';
import Navbar from '../Navbar';
import { renderWithIntl } from '@/test-utils/renderWithIntl';

jest.mock('@/components/wallet/ConnectWalletButton', () => ({
  ConnectWalletButton: ({ className }: { className?: string }) => (
    <button className={className} data-testid="connect-wallet-btn">
      Connect Wallet
    </button>
  ),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

describe('Navbar', () => {
  it('renders the brand name', () => {
    renderWithIntl(<Navbar />);
    expect(screen.getByText('INVERSE')).toBeInTheDocument();
    expect(screen.getByText('ARENA')).toBeInTheDocument();
  });

  it('renders navigation links', () => {
    renderWithIntl(<Navbar />);
    expect(screen.getByRole('link', { name: /the_protocol/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /why_inverse/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /win_or_lose/i })).toBeInTheDocument();
  });

  it('renders the connect wallet button', () => {
    renderWithIntl(<Navbar />);
    expect(screen.getByTestId('connect-wallet-btn')).toBeInTheDocument();
  });

  it('matches snapshot', () => {
    const { container } = renderWithIntl(<Navbar />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
