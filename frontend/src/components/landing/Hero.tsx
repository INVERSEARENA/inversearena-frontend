'use client'
import React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

const Hero = () => {
    const router = useRouter();
    const t = useTranslations('landing.hero');
    const tCommon = useTranslations('common');

    return (
        <section className="relative pt-40 pb-20 px-6 max-w-7xl mx-auto w-full flex flex-col items-center text-center">
            <div className="relative z-10 flex flex-col items-center">
                <h1 className="text-[12vw] lg:text-[180px] font-extralight tracking-[-0.05em] leading-[0.9] mb-12 select-none">
                    <span className="text-white block">INVERSE</span>
                    <span className="text-neon-green block italic">ARENA</span>
                </h1>

                <div className="w-full max-w-xl py-6 mb-16 border-y border-white/5">
                    <p className="text-[10px] md:text-xs font-mono tracking-[0.4em] uppercase text-zinc-300 leading-relaxed font-medium">
                        {t('tagline1')} <br className="hidden md:block" />
                        {t('tagline2')}
                    </p>
                </div>

                <button
                    type="button"
                    onClick={() => router.push('/dashboard')}
                    className="group relative"
                >
                    <div className="px-16 py-6 bg-neon-green text-black font-bold text-3xl uppercase transform transition-transform group-hover:scale-105 active:scale-95 shadow-lg">
                        {tCommon('playNow')}
                    </div>
                </button>
            </div>
        </section>
    );
};

export default Hero;
