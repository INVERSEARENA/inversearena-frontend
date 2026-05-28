import React from 'react';
import { render, screen } from '@testing-library/react';
import Navbar from '../Navbar';

jest.mock('@/components/wallet/ConnectWalletButton', () => ({
  ConnectWalletButton: ({ className }: { className?: string }) => (
    <button className={className} data-testid="connect-wallet-btn">
      Connect Wallet
    </button>
  ),
}));

describe('Navbar', () => {
  it('renders the brand name', () => {
    render(<Navbar />);
    expect(screen.getByText('INVERSE')).toBeInTheDocument();
    expect(screen.getByText('ARENA')).toBeInTheDocument();
  });

  it('renders navigation links', () => {
    render(<Navbar />);
    expect(screen.getByRole('link', { name: /the_protocol/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /why_inverse/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /win_or_lose/i })).toBeInTheDocument();
  });

  it('renders the connect wallet button', () => {
    render(<Navbar />);
    expect(screen.getByTestId('connect-wallet-btn')).toBeInTheDocument();
  });

  it('matches snapshot', () => {
    const { container } = render(<Navbar />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
