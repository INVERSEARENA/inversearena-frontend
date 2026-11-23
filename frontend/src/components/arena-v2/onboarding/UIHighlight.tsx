"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";

type HighlightRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

interface UIHighlightProps {
  anchors: string[];
  showPointers?: boolean;
}

export function UIHighlight({ anchors, showPointers = false }: UIHighlightProps) {
  const [rects, setRects] = useState<HighlightRect[]>([]);

  const uniqueAnchors = useMemo(() => Array.from(new Set(anchors)), [anchors]);

  useEffect(() => {
    const collectRects = () => {
      const nextRects = uniqueAnchors
        .map((anchor) => {
          const element = document.querySelector(`[data-tour-anchor="${anchor}"]`);
          if (!element) {
            return null;
          }

          const box = element.getBoundingClientRect();
          const padding = 8;
          return {
            top: Math.max(box.top - padding, 8),
            left: Math.max(box.left - padding, 8),
            width: box.width + padding * 2,
            height: box.height + padding * 2,
          };
        })
        .filter((rect): rect is HighlightRect => rect !== null);

      setRects(nextRects);
    };

    collectRects();
    window.addEventListener("resize", collectRects);
    window.addEventListener("scroll", collectRects, true);

    return () => {
      window.removeEventListener("resize", collectRects);
      window.removeEventListener("scroll", collectRects, true);
    };
  }, [uniqueAnchors]);

  return (
    <div className="fixed inset-0 z-[90] pointer-events-none" aria-hidden>
      <div className="absolute inset-0 bg-black/80" />

      {rects.map((rect, index) => (
        <motion.div
          key={`${rect.left}-${rect.top}-${index}`}
          className="absolute border-2 border-neon-green shadow-[0_0_0_1px_#000,0_0_18px_rgba(55,255,28,0.6)]"
          style={{
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          }}
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2 }}
        />
      ))}

      {showPointers &&
        rects.map((rect, index) => (
          <motion.div
            key={`pointer-${rect.left}-${rect.top}-${index}`}
            className="absolute text-neon-green text-4xl font-bold"
            style={{
              top: Math.max(rect.top - 46, 10),
              left: rect.left + rect.width / 2 - 12,
            }}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: [0, 6, 0] }}
            transition={{ duration: 1.2, repeat: Number.POSITIVE_INFINITY, repeatType: "loop" }}
          >
            ↓
          </motion.div>
        ))}
    </div>
  );
}
