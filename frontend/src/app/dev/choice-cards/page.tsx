"use client";

import { useState } from "react";
import { ChoiceCard } from "@/components/arena/core/ChoiceCard";
import { SelectionCard } from "@/components/arena-v2/choice/SelectionCard";

/**
 * Choice-card gallery (#1645). Covers default / selected / disabled states of
 * both the core ChoiceCard and the arena-v2 SelectionCard.
 */
export default function ChoiceCardsGallery() {
  const [coreSelected, setCoreSelected] = useState<"heads" | "tails" | null>(null);
  const [v2Selected, setV2Selected] = useState<"heads" | "tails" | null>("heads");

  return (
    <div className="space-y-10">
      <section>
        <h2 className="mb-3 text-lg font-semibold">core/ChoiceCard</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <ChoiceCard
            type="heads"
            estimatedYield={2.4}
            isSelected={coreSelected === "heads"}
            onSelect={() => setCoreSelected("heads")}
          />
          <ChoiceCard
            type="tails"
            estimatedYield={2.4}
            isSelected={coreSelected === "tails"}
            onSelect={() => setCoreSelected("tails")}
          />
          <ChoiceCard type="heads" estimatedYield={2.4} disabled />
          <ChoiceCard type="tails" estimatedYield={2.4} disabled />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">arena-v2/SelectionCard</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectionCard
            type="heads"
            yieldPercentage={2.4}
            isSelected={v2Selected === "heads"}
            onSelect={() => setV2Selected("heads")}
          />
          <SelectionCard
            type="tails"
            yieldPercentage={2.4}
            isSelected={v2Selected === "tails"}
            onSelect={() => setV2Selected("tails")}
          />
        </div>
      </section>
    </div>
  );
}
