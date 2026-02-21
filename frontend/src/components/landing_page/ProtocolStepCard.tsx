import type { ReactNode } from "react";

export interface ProtocolStepCardProps {
  number: string;
  title: string;
  description: string;
  icon: ReactNode;
  bgColor: string;
  textColor: string;
  index: number;
}

export function ProtocolStepCard({ 
  number, 
  title, 
  description, 
  icon, 
  bgColor,
  textColor,
  index
}: ProtocolStepCardProps) {
  return (
    <div className={`${bgColor} p-10 flex flex-col items-center justify-between min-h-[550px] shadow-2xl`}>
      <div className="w-full">
        <div className="flex justify-between items-start mb-16">
          <h3 className={`text-2xl font-extralight ${textColor} leading-tight max-w-[150px] uppercase font-sans`}>
            {index + 1}. {title}
          </h3>
          <span className={`text-4xl font-extralight ${textColor} opacity-20 font-mono tracking-tighter`}>
            {number}
          </span>
        </div>
      </div>

      <div className="flex-grow flex items-center justify-center">
        {icon}
      </div>

      <div className="w-full pt-12">
        <p className={`text-[11px] font-medium leading-relaxed ${textColor} max-w-[200px] font-mono uppercase tracking-wide`}>
          {description}
        </p>
      </div>
    </div>
  );
}