import React from 'react';
import FeatureCard from './FeatureCard';

const WhyInverse = () => {
    const features = [
        {
            title: "SAFE & SECURE",
            description: "Built on Stellar Soroban's battle-tested infrastructure. Your assets are protected by audited smart contracts.",
            icon: (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
            )
        },
        {
            title: "INSTANT WINS",
            description: "No waiting for withdrawals. Rewards are distributed instantly to your wallet the moment the round concludes.",
            icon: (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m13 2-2 10h8l-2 10" /></svg>
            )
        },
        {
            title: "NO FEES",
            description: "The protocol takes zero cuts from your stake. Operations are funded entirely by the treasury's yield margins.",
            icon: (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11 15h2a2 2 0 1 0 0-4h-3c-1.1 0-2-.9-2-2V5c0-1.1.9-2 2-2h2" /><path d="M18 11h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-1" /></svg>
            )
        }
    ];

    return (
        <section id="why" className="py-24 px-6 max-w-6xl mx-auto w-full">
            <div className="flex items-center gap-6 mb-16">
                <h2 className="text-4xl font-extralight italic tracking-tighter text-zinc-100 uppercase whitespace-nowrap">
                    WHY INVERSE?
                </h2>
                <div className="h-[1px] flex-grow bg-gradient-to-r from-neon-pink/40 to-transparent" />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {features.map((feature, index) => (
                    <FeatureCard
                        key={index}
                        {...feature}
                    />
                ))}
            </div>
        </section>
    );
};

export default WhyInverse;
