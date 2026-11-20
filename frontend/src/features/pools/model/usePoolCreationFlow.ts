"use client";

import { useCallback, useEffect, useReducer } from "react";

export type PoolCreationStep = "configure" | "review" | "signing" | "success";
type FlowEvent = "REVIEW" | "EDIT" | "SIGN" | "CONFIRM" | "RESET";

const transitions: Readonly<Record<PoolCreationStep, Partial<Record<FlowEvent, PoolCreationStep>>>> = {
  configure: { REVIEW: "review", RESET: "configure" },
  review: { EDIT: "configure", SIGN: "signing", RESET: "configure" },
  signing: { CONFIRM: "success", RESET: "configure" },
  success: { RESET: "configure" },
};

export function transitionPoolCreation(step: PoolCreationStep, event: FlowEvent): PoolCreationStep {
  return transitions[step][event] ?? step;
}

export function usePoolCreationFlow(isOpen: boolean) {
  const [step, dispatch] = useReducer(transitionPoolCreation, "configure");
  useEffect(() => {
    if (!isOpen) dispatch("RESET");
  }, [isOpen]);
  const review = useCallback(() => dispatch("REVIEW"), []);
  const edit = useCallback(() => dispatch("EDIT"), []);
  const sign = useCallback(() => dispatch("SIGN"), []);
  const confirm = useCallback(() => dispatch("CONFIRM"), []);
  const reset = useCallback(() => dispatch("RESET"), []);
  return { step, review, edit, sign, confirm, reset } as const;
}
