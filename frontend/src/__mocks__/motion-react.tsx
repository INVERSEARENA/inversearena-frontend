import React from "react";

function createMotionProxy(): Record<string, React.FC<React.HTMLAttributes<HTMLElement>>> {
  return new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        const Component = ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) =>
          React.createElement(tag, rest, children);
        Component.displayName = `motion.${tag}`;
        return Component;
      },
    },
  );
}

const motion = createMotionProxy();

export const m = motion;
export { motion };
export const domAnimation = {};
export function LazyMotion({ children }: { children: React.ReactNode }) {
  return React.createElement(React.Fragment, null, children);
}
export function AnimatePresence({ children }: { children: React.ReactNode }) {
  return React.createElement(React.Fragment, null, children);
}
export function useReducedMotion() {
  return false;
}
