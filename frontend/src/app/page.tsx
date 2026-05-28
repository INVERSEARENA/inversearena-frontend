import Navbar from "@/components/landing/Navbar";
import Hero from "@/components/landing/Hero";
import Protocol from "@/components/landing/Protocol";
import WhyInverse from "@/components/landing/WhyInverse";
import YieldShowcase from "@/components/landing/YieldShowcase";
import BottomCta from "@/components/landing/BottomCta";
import Footer from "@/components/landing/Footer";

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
