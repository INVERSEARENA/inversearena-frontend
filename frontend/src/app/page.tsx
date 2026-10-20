import Navbar from "@/components/landing/Navbar";
import Hero from "@/components/landing/Hero";
import Protocol from "@/components/landing/Protocol";
import WhyInverse from "@/components/landing/WhyInverse";
import YieldShowcase from "@/components/landing/YieldShowcase";
import BottomCta from "@/components/landing/BottomCta";
import Footer from "@/components/landing/Footer";
import LandingStatsStrip from "@/components/landing/LandingStatsStrip";
import { fetchLandingStats, LANDING_REVALIDATE_SECONDS } from "@/shared/lib/landingStats";

// #1626: serve the landing page from the CDN edge and refresh at most once
// per minute. The stats fetch is additionally tagged (`landing-stats`) so an
// on-chain configuration change can drop it immediately via the revalidation
// webhook instead of waiting out this window.
export const revalidate = LANDING_REVALIDATE_SECONDS;

export default async function Home() {
  const stats = await fetchLandingStats();

  return (
    <div className="flex min-h-screen flex-col bg-dark-bg text-white selection:bg-neon-green selection:text-black">
      <Navbar />

      <main className="flex-grow">
        <Hero />
        <LandingStatsStrip stats={stats} />
        <Protocol />
        <WhyInverse />
        <YieldShowcase />
        <BottomCta />
      </main>

      <Footer />
    </div>
  );
}
