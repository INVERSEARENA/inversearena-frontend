import { Hero, ProtocolSteps } from "@/components/landing_page";

export default function Home() {
  return (
    <div className="min-h-screen bg-slate-950">
      <Hero />
      <ProtocolSteps />
    </div>
  );
}