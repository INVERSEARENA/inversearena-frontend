"use client";

import React, { useState, useEffect, useRef } from 'react';
import { useQueryState } from '@/shared-d/hooks/useQueryState';
import { useDebouncedValue } from '@/shared-d/hooks/useDebouncedValue';

type FilterType = "all" | "high-stakes" | "fast-rounds";

export const GamesFilters = () => {
    const tabs: { label: string; value: FilterType }[] = [
        { label: "ALL ARENAS", value: "all" },
        { label: "HIGH STAKES", value: "high-stakes" },
        { label: "FAST ROUNDS", value: "fast-rounds" }
    ];

    // Sync filter state with URL
    const [filter, setFilter] = useQueryState<FilterType>("filter", {
        defaultValue: "all"
    });

    // Sync search state with URL (debounced)
    const [search, setSearch] = useQueryState<string>("q", {
        defaultValue: ""
    });

    // Local state for search input (for immediate UI feedback). Seeded from the
    // URL so a deep link or a reload never starts out of step with the filter
    // that is already applied.
    const [searchInput, setSearchInput] = useState(search);

    // Debounce the search input before updating URL
    const debouncedSearch = useDebouncedValue(searchInput, 500);

    // The last `q` value this component itself put into the URL. Any other value
    // the URL reports came from outside the input — browser back/forward, a
    // pasted link — and has to be pulled back into the box (#1341).
    const lastPushedSearch = useRef(search);

    useEffect(() => {
        if (search === lastPushedSearch.current) {
            return;
        }
        // Externally-driven URL change: adopt it. Without this the box kept
        // displaying a stale term after Back, and the next keystroke re-applied
        // that stale filter through the effect below.
        lastPushedSearch.current = search;
        setSearchInput(search);
    }, [search]);

    // Update URL when debounced search changes
    useEffect(() => {
        // While the debounce is still catching up to an externally-adopted value
        // the two differ for reasons that are not the user typing; pushing then
        // would clobber the URL that was just restored.
        if (debouncedSearch !== searchInput) {
            return;
        }
        if (debouncedSearch !== search) {
            lastPushedSearch.current = debouncedSearch;
            setSearch(debouncedSearch || null);
        }
    }, [debouncedSearch, searchInput, search, setSearch]);

    return (
        <div className="flex items-center justify-between border-y border-white/10 py-4 mb-8">
            <div className="flex gap-4">
                {tabs.map((tab) => (
                    <button
                        key={tab.value}
                        onClick={() => setFilter(tab.value === "all" ? null : tab.value)}
                        className={`px-6 py-2 text-[10px] font-bold tracking-widest uppercase transition-all border ${filter === tab.value
                                ? "bg-neon-green text-black border-neon-green"
                                : "bg-transparent text-zinc-400 border-white/10 hover:border-white/20"
                            }`}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            <div className="relative group">
                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                    <svg className="w-3 h-3 text-neon-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                </div>
                <input
                    type="text"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="FILTER_BY_ID"
                    className="bg-black/60 border border-white/10 pl-10 pr-4 py-2 text-[10px] font-mono tracking-widest text-zinc-400 focus:outline-none focus:border-neon-green/50 w-64 uppercase"
                />
            </div>
        </div>
    );
};

