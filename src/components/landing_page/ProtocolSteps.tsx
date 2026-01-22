import { ProtocolStepCard } from "./ProtocolStepCard";

export function ProtocolSteps() {
  const steps = [
    {
      number: "01",
      title: "STAKE AND JOIN ARENA",
      description: "Stake your XLM to access the active pools. Your entry immediately begins generating RWA yield while the round prepares.",
      bgColor: "bg-white",
      textColor: "text-black",
      icon: (
        <div className="w-24 h-24 bg-[#09101D] p-5 border border-green-400/20">
          <svg viewBox="0 0 24 24" fill="none" className="w-full h-full text-green-400">
            <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
            <path d="M12 9V15M9 12H15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      )
    },
    {
      number: "02",
      title: "PICK A SIDE",
      description: "Make your strategic choice between Heads or Tails. To survive the round, you must commit to the side that fewer players choose.",
      bgColor: "bg-green-400",
      textColor: "text-black",
      icon: (
        <div className="w-24 h-24 bg-black p-5">
          <svg viewBox="0 0 24 24" fill="none" className="w-full h-full text-white">
            <path d="M17 10L21 6L17 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M7 14L3 18L7 22" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M21 6H12C10 6 8 8 8 10V14C8 16 10 18 12 18H3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )
    },
    {
      number: "03",
      title: "BE AMONG THE MINORITY TO WIN",
      description: "Only the minority side survives and moves to the next round. Winners split the rewards, and everyone keeps their earned interest.",
      bgColor: "bg-white",
      textColor: "text-black",
      icon: (
        <div className="w-24 h-24 bg-[#09101D] p-5 border border-green-400/20">
          <svg viewBox="0 0 24 24" fill="none" className="w-full h-full text-green-400">
            <path d="M12 2L12 15M12 2L4 7M12 2L20 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 15L4 10V18L12 22L20 18V10L12 15Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        </div>
      )
    }
  ];

  return (
    <section id="protocol" className="py-24 px-6 max-w-6xl mx-auto w-full">
      <div className="mb-12">
        <h2 className="text-4xl font-extralight tracking-tight text-white uppercase mb-1">
          THE PROTOCOL
        </h2>
        <span className="text-[10px] text-zinc-500 font-mono tracking-[0.2em] uppercase">
          Core Mechanism Overview
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {steps.map((step, index) => (
          <ProtocolStepCard
            key={index}
            number={step.number}
            title={step.title}
            description={step.description}
            icon={step.icon}
            bgColor={step.bgColor}
            textColor={step.textColor}
            index={index}
          />
        ))}
      </div>
    </section>
  );
}