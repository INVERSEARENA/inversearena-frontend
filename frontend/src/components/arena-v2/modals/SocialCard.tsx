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
    flex items-center justify-start gap-4
    px-5 py-4 transition-all duration-200
    font-black tracking-widest text-[10px] uppercase
    cursor-pointer
    shadow-[6px_6px_0px_0px_#000]
  `.trim();

  const outlineClasses = `
    border-2 border-black bg-white text-black
    hover:bg-black/5
    active:scale-95
  `.trim();

  const filledClasses = `
    bg-[#39FF14] text-black border-2 border-black
    hover:bg-[#2de010]
    hover:shadow-[8px_8px_0px_0px_#000]
    active:scale-95
  `.trim();

  const variantClass = variant === 'filled' ? filledClasses : outlineClasses;

  return (
    <button
      onClick={onClick}
      className={`${baseClasses} ${variantClass}`}
      style={{ borderRadius: 0 }}
    >
      <div className="text-xl flex-shrink-0">{icon}</div>
      <div className="text-left leading-tight">{label}</div>
    </button>
  );
};
