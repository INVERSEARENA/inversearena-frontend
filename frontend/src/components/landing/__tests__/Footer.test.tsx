import React from 'react';
import { render, screen } from '@testing-library/react';
import Footer from '../Footer';

describe('Footer', () => {
  it('renders the brand name', () => {
    render(<Footer />);
    expect(screen.getByText('INVERSE')).toBeInTheDocument();
    expect(screen.getByText('_ARENA')).toBeInTheDocument();
  });

  it('renders the protocol description', () => {
    render(<Footer />);
    expect(
      screen.getByText(/A DECENTRALIZED GAME THEORY PROTOCOL ON SOROBAN/i),
    ).toBeInTheDocument();
  });

  it('renders SYSTEM section links', () => {
    render(<Footer />);
    expect(screen.getByRole('link', { name: /status_log/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /yield_oracle/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /security_audit/i })).toBeInTheDocument();
  });

  it('renders COMMUNITY section links', () => {
    render(<Footer />);
    expect(screen.getByRole('link', { name: /discord/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /x_terminal/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /governance/i })).toBeInTheDocument();
  });

  it('renders copyright notice', () => {
    render(<Footer />);
    expect(screen.getByText(/© 2026 INVERSE_ARENA_PROTOCOL/i)).toBeInTheDocument();
  });

  it('renders network status', () => {
    render(<Footer />);
    expect(screen.getByText(/NETWORK_STATUS: OPTIMAL/i)).toBeInTheDocument();
  });

  it('matches snapshot', () => {
    const { container } = render(<Footer />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
