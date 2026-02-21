'use client';

import SurgeAlertBanner from '@/components/arena-v2/yield-surge/SurgeAlertBanner';
import MultiplierCard from '@/components/arena-v2/yield-surge/MultiplierCard';
import SurgeTimer from '@/components/arena-v2/yield-surge/SurgeTimer';
import StatusRibbon from '@/components/arena-v2/yield-surge/StatusRibbon';
import BenefitCards from '@/components/arena-v2/yield-surge/BenefitCards';

export default function YieldSurgePage() {
  return (
    <div className="min-h-screen bg-[#09101D] text-white">
      {/* Alert Banner */}
      <SurgeAlertBanner />

      {/* Main Content Container */}
      <div className="max-w-7xl mx-auto px-6 py-12">
        {/* Top Section: Multiplier and Timer */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-12">
          {/* Left: Multiplier Card */}
          <MultiplierCard />

          {/* Right: Timer and Announcement */}
          <SurgeTimer initialSeconds={9912} />
        </div>

        {/* Status Ribbon */}
        <div className="mb-12">
          <StatusRibbon />
        </div>

        {/* Benefit Cards */}
        <BenefitCards />
      </div>
    </div>
  );
}
