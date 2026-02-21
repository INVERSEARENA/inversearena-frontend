"use client";

import {
  type ReactNode,
  type KeyboardEvent,
  useEffect,
  useRef,
  useCallback,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, type Variants, type Transition } from "motion/react";

export type ModalSize = "sm" | "md" | "lg" | "full";
export type ModalPosition = "center" | "bottom-sheet";

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  size?: ModalSize;
  position?: ModalPosition;
  closeOnOverlayClick?: boolean;
  closeOnEscape?: boolean;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  className?: string;
  overlayClassName?: string;
}

const sizeStyles: Record<ModalSize, string> = {
  sm: "max-w-sm w-full",
  md: "max-w-md w-full",
  lg: "max-w-2xl w-full",
  full: "max-w-full w-full h-full",
};

const positionStyles: Record<ModalPosition, string> = {
  center: "items-center justify-center",
  "bottom-sheet": "items-end justify-center",
};

const containerPositionStyles: Record<ModalPosition, string> = {
  center: "rounded-2xl",
  "bottom-sheet": "rounded-t-2xl rounded-b-none",
};

const overlayVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

const modalVariants: Record<ModalPosition, Variants> = {
  center: {
    hidden: { opacity: 0, scale: 0.95, y: 10 },
    visible: { opacity: 1, scale: 1, y: 0 },
    exit: { opacity: 0, scale: 0.95, y: 10 },
  },
  "bottom-sheet": {
    hidden: { opacity: 0, y: "100%" },
    visible: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: "100%" },
  },
};

const transitionConfig: Transition = {
  type: "spring",
  damping: 25,
  stiffness: 300,
};

function useFocusTrap(isOpen: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    previousActiveElement.current = document.activeElement as HTMLElement;

    const container = containerRef.current;
    if (container) {
      container.focus();
    }

    return () => {
      previousActiveElement.current?.focus();
    };
  }, [isOpen]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;

    const container = containerRef.current;
    if (!container) return;

    const focusableElements = container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (event.shiftKey) {
      if (document.activeElement === firstElement) {
        event.preventDefault();
        lastElement?.focus();
      }
    } else {
      if (document.activeElement === lastElement) {
        event.preventDefault();
        firstElement?.focus();
      }
    }
  }, []);

  return { containerRef, handleKeyDown };
}

function useBodyScrollLock(isOpen: boolean) {
  useEffect(() => {
    if (!isOpen) return;

    const originalOverflow = document.body.style.overflow;
    const originalPaddingRight = document.body.style.paddingRight;

    const scrollbarWidth =
      window.innerWidth - document.documentElement.clientWidth;

    document.body.style.overflow = "hidden";
    document.body.style.paddingRight = `${scrollbarWidth}px`;

    return () => {
      document.body.style.overflow = originalOverflow;
      document.body.style.paddingRight = originalPaddingRight;
    };
  }, [isOpen]);
}

export function Modal({
  isOpen,
  onClose,
  children,
  size = "md",
  position = "center",
  closeOnOverlayClick = true,
  closeOnEscape = true,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  className = "",
  overlayClassName = "",
}: ModalProps) {
  const { containerRef, handleKeyDown } = useFocusTrap(isOpen);

  useBodyScrollLock(isOpen);

  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;

    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, closeOnEscape, onClose]);

  const handleOverlayClick = useCallback(() => {
    if (closeOnOverlayClick) {
      onClose();
    }
  }, [closeOnOverlayClick, onClose]);

  const handleContentClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.stopPropagation();
    },
    []
  );

  if (typeof window === "undefined") return null;

  return createPortal(
    <AnimatePresence mode="wait">
      {isOpen && (
        <motion.div
          className={`fixed inset-0 z-50 flex p-4 ${positionStyles[position]} ${overlayClassName}`}
          variants={overlayVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          transition={{ duration: 0.2 }}
          onClick={handleOverlayClick}
          aria-hidden="true"
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

          <motion.div
            ref={containerRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            aria-describedby={ariaDescribedBy}
            tabIndex={-1}
            className={`
              relative z-10
              bg-white dark:bg-zinc-900
              shadow-2xl
              ${sizeStyles[size]}
              ${containerPositionStyles[position]}
              ${size === "full" ? "h-full" : "max-h-[90vh]"}
              overflow-auto
              outline-none
              ${className}
            `}
            variants={modalVariants[position]}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={transitionConfig}
            onClick={handleContentClick}
            onKeyDown={handleKeyDown}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
