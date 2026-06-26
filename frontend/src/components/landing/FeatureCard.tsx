import React from 'react';

interface FeatureCardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
}

const FeatureCard = ({ title, description, icon }: FeatureCardProps) => {
  return (
    <div className="group relative flex flex-col items-start p-8 bg-transparent border-[1.5px] border-neon-green transition-all duration-300 hover:bg-neon-green/5">
      <div className="mb-6 w-12 h-12 flex items-center justify-center bg-neon-green text-black">
        <div className="w-5 h-5">
          {icon}
        </div>
      </div>
      <h3 className="mb-4 text-xl font-extralight uppercase tracking-tight text-neon-green italic leading-none">
        {title}
      </h3>
      <p className="text-zinc-300 leading-relaxed font-mono text-[10px] uppercase font-medium tracking-widest opacity-80">
        {description}
      </p>
    </div>
  );
};

export default FeatureCard;
