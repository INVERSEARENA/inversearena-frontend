import React from 'react';
import { render, screen } from '@testing-library/react';
import Hero from '../Hero';

describe('Hero', () => {
  it('renders the headline', () => {
    render(<Hero />);
    expect(screen.getByText(/INVERSE/i)).toBeInTheDocument();
    expect(screen.getByText(/ARENA/i)).toBeInTheDocument();
  });

  it('renders the tagline', () => {
    render(<Hero />);
    expect(
      screen.getByText(/THE SOCIAL ELIMINATION GAME WHERE THE MINORITY/i),
    ).toBeInTheDocument();
  });

  it('renders the PLAY NOW CTA button', () => {
    render(<Hero />);
    expect(screen.getByRole('button', { name: /play now/i })).toBeInTheDocument();
  });

  it('matches snapshot', () => {
    const { container } = render(<Hero />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
