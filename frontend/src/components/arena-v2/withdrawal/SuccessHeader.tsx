"use client";

import { motion } from "framer-motion";

export function SuccessHeader() {
  return (
    <motion.div
      initial={{ opacity: 0, y: -30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="flex flex-col items-center gap-3 text-center"
    >
      <p className="font-mono text-xs tracking-[0.25em] text-neon-green uppercase">
        // PROTOCOL_SUCCESS // TRANSACTION_COMPLETE
      </p>
      <h1 className="font-black text-5xl md:text-6xl lg:text-7xl text-neon-green tracking-widest uppercase">
        FUNDS_SECURED
      </h1>
    </motion.div>
  );
}
