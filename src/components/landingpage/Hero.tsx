'use client'
import React from 'react';
import { useState } from "react";

const Hero = () => {
    const [isModalOpen, setIsModalOpen] = useState(false);

    const handleConfirm = async () => {
        console.log("confirm logic here");
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return (
        <section className="relative pt-40 pb-20 px-6 max-w-7xl mx-auto w-full flex flex-col items-center text-center">
            <div className="relative z-10 flex flex-col items-center">
                <h1 className="text-[12vw] lg:text-[180px] font-extralight tracking-[-0.05em] leading-[0.9] mb-12 select-none">
                    <span className="text-white block">INVERSE</span>
                    <span className="text-neon-green block italic">ARENA</span>
                </h1>

                <div className="w-full max-w-xl py-6 mb-16 border-y border-white/5">
                    <p className="text-[10px] md:text-xs font-mono tracking-[0.4em] uppercase text-zinc-300 leading-relaxed font-medium">
                        THE SOCIAL ELIMINATION GAME WHERE THE MINORITY <br className="hidden md:block" />
                        WINS AND EVERYONE EARNS.
                    </p>
                </div>

                <button
                    type="button"
                    className="group relative"
                >
                    <div className="px-16 py-6 bg-neon-green text-black font-bold text-3xl uppercase transform transition-transform group-hover:scale-105 active:scale-95 shadow-lg">
                        PLAY NOW
                    </div>
                </button>
            </div>
        </section>
    );
};

export default Hero;
