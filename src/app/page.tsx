import Navbar from "@/components/landingpage/Navbar";
import Hero from "@/components/landingpage/Hero";
import Protocol from "@/components/landingpage/Protocol";
import WhyInverse from "@/components/landingpage/WhyInverse";
import YieldShowcase from "@/components/landingpage/YieldShowcase";
import BottomCta from "@/components/landingpage/BottomCta";
import Footer from "@/components/landingpage/Footer";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-dark-bg text-white selection:bg-neon-green selection:text-black">
      <Navbar />

      <main className="flex-grow">
        <Hero />
        <Protocol />
        <WhyInverse />
        <YieldShowcase />
        <BottomCta />
      </main>

      <Footer />
    </div>
  );
}