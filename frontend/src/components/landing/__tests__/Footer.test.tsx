import React from 'react';
import { screen } from '@testing-library/react';
import Footer from '../Footer';
import { renderWithIntl } from '@/test-utils/renderWithIntl';

describe('Footer', () => {
  it('renders the brand name', () => {
    renderWithIntl(<Footer />);
    expect(screen.getByText('INVERSE')).toBeInTheDocument();
    expect(screen.getByText('_ARENA')).toBeInTheDocument();
  });

  it('renders the protocol description', () => {
    renderWithIntl(<Footer />);
    expect(
      screen.getByText(/A DECENTRALIZED GAME THEORY PROTOCOL ON SOROBAN/i),
    ).toBeInTheDocument();
  });

  it('renders SYSTEM section links', () => {
    renderWithIntl(<Footer />);
    expect(screen.getByRole('link', { name: /status_log/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /yield_oracle/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /security_audit/i })).toBeInTheDocument();
  });

  it('renders COMMUNITY section links', () => {
    renderWithIntl(<Footer />);
    expect(screen.getByRole('link', { name: /discord/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /x_terminal/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /governance/i })).toBeInTheDocument();
  });

  it('renders copyright notice', () => {
    renderWithIntl(<Footer />);
    expect(screen.getByText(/© 2026 INVERSE_ARENA_PROTOCOL/i)).toBeInTheDocument();
  });

  it('renders network status', () => {
    renderWithIntl(<Footer />);
    expect(screen.getByText(/NETWORK_STATUS: OPTIMAL/i)).toBeInTheDocument();
  });

  it('matches snapshot', () => {
    const { container } = renderWithIntl(<Footer />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
