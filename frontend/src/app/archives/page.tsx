import { ArchivesFilterBar } from "@/components/archives/global/ArchivesFilterBar";
import { ArchivesHeader } from "@/components/archives/global/ArchivesHeader";
import { GlobalPerformanceStats } from "@/components/archives/global/GlobalPerformanceStats";

export default function ArchivesPage() {
  return (
    <div className="min-h-screen bg-[#050B15] px-4 py-6 md:px-8 md:py-8">
      <section className="mx-auto w-full max-w-6xl overflow-hidden border-[3px] border-[#0E1A2D] bg-[#0A1324]">
        <ArchivesHeader />

        <div className="px-4 py-5 md:px-8 md:py-6">
          <GlobalPerformanceStats />
          <ArchivesFilterBar />
        </div>
      </section>
    </div>
  );
}
