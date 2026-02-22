'use client';

import React from 'react';

interface SocialCardProps {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  variant?: 'outline' | 'filled';
}

export const SocialCard: React.FC<SocialCardProps> = ({
  label,
  icon,
  onClick,
  variant = 'outline',
}) => {
  const baseClasses = `
    flex flex-col items-center justify-center
    p-6 transition-all duration-200
    font-black tracking-widest text-xs uppercase
    cursor-pointer
  `.trim();

  const outlineClasses = `
    border-2 border-white text-white
    hover:bg-white/10 hover:shadow-lg
    active:scale-95
  `.trim();

  const filledClasses = `
    bg-[#39FF14] text-black border-2 border-[#39FF14]
    hover:bg-[#2de010] hover:border-[#2de010]
    hover:shadow-[0_0_20px_rgba(57,255,20,0.5)]
    active:scale-95
  `.trim();

  const variantClass = variant === 'filled' ? filledClasses : outlineClasses;

  return (
    <button
      onClick={onClick}
      className={`${baseClasses} ${variantClass}`}
      style={{ borderRadius: 0 }}
    >
      <div className="mb-3 text-2xl">{icon}</div>
      <div className="text-center">{label}</div>
    </button>
  );
};
