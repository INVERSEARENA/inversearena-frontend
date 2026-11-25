import React from 'react';
import { screen } from '@testing-library/react';
import Hero from '../Hero';
import { renderWithIntl } from '@/test-utils/renderWithIntl';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

describe('Hero', () => {
  it('renders the headline', () => {
    renderWithIntl(<Hero />);
    expect(screen.getByText(/INVERSE/i)).toBeInTheDocument();
    expect(screen.getByText(/ARENA/i)).toBeInTheDocument();
  });

  it('renders the tagline', () => {
    renderWithIntl(<Hero />);
    expect(
      screen.getByText(/THE SOCIAL ELIMINATION GAME WHERE THE MINORITY/i),
    ).toBeInTheDocument();
  });

  it('renders the PLAY NOW CTA button', () => {
    renderWithIntl(<Hero />);
    expect(screen.getByRole('button', { name: /play now/i })).toBeInTheDocument();
  });

  it('matches snapshot', () => {
    const { container } = renderWithIntl(<Hero />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
