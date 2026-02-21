"use client";

import { useCallback } from "react";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  maxVisiblePages?: number;
  className?: string;
}

// Pagination with keyboard accessibility
export function Pagination({
  currentPage,
  totalPages,
  onPageChange,
  maxVisiblePages = 3,
  className = "",
}: PaginationProps) {
  // Build array of page numbers with ellipsis for gaps
  const getVisiblePages = useCallback((): (number | "ellipsis")[] => {
    const pages: (number | "ellipsis")[] = [];

    if (totalPages <= maxVisiblePages + 2) {
      // Show all pages if total is small
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      pages.push(1);

      const startPage = Math.max(2, currentPage - 1);
      const endPage = Math.min(totalPages - 1, currentPage + 1);

      if (startPage > 2) pages.push("ellipsis");

      for (let i = startPage; i <= endPage; i++) {
        pages.push(i);
      }

      if (endPage < totalPages - 1) pages.push("ellipsis");

      if (totalPages > 1) pages.push(totalPages);
    }

    return pages;
  }, [currentPage, totalPages, maxVisiblePages]);

  const handlePrevious = useCallback(() => {
    if (currentPage > 1) {
      onPageChange(currentPage - 1);
    }
  }, [currentPage, onPageChange]);

  const handleNext = useCallback(() => {
    if (currentPage < totalPages) {
      onPageChange(currentPage + 1);
    }
  }, [currentPage, totalPages, onPageChange]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent, action: () => void) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        action();
      }
    },
    []
  );

  if (totalPages <= 1) {
    return null;
  }

  const visiblePages = getVisiblePages();

  return (
    <nav
      className={`flex items-center justify-center gap-2 ${className}`}
      aria-label="Pagination"
      role="navigation"
    >
      {/* Previous button - hidden on first page per design */}
      {currentPage > 1 && (
        <button
          onClick={handlePrevious}
          onKeyDown={(e) => handleKeyDown(e, handlePrevious)}
          disabled={currentPage === 1}
          className="flex h-10 w-10 items-center justify-center border border-white/20 bg-transparent text-white/60 transition-colors hover:border-white/40 hover:text-white focus:outline-none focus:ring-2 focus:ring-neon-green focus:ring-offset-2 focus:ring-offset-dark-bg disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Go to previous page"
        >
          <ChevronLeftIcon />
        </button>
      )}

      {/* Page numbers */}
      {visiblePages.map((page, index) =>
        page === "ellipsis" ? (
          <span
            key={`ellipsis-${index}`}
            className="flex h-10 w-10 items-center justify-center text-white/40"
            aria-hidden="true"
          >
            ...
          </span>
        ) : (
          <button
            key={page}
            onClick={() => onPageChange(page)}
            onKeyDown={(e) => handleKeyDown(e, () => onPageChange(page))}
            className={`flex h-10 w-10 items-center justify-center border font-mono text-sm font-bold transition-colors focus:outline-none focus:ring-2 focus:ring-neon-green focus:ring-offset-2 focus:ring-offset-dark-bg ${
              page === currentPage
                ? "border-white bg-white text-black"
                : "border-white/20 bg-transparent text-white hover:border-white/40"
            }`}
            aria-label={`Go to page ${page}`}
            aria-current={page === currentPage ? "page" : undefined}
          >
            {page}
          </button>
        )
      )}

      {/* Next button */}
      <button
        onClick={handleNext}
        onKeyDown={(e) => handleKeyDown(e, handleNext)}
        disabled={currentPage === totalPages}
        className="flex h-10 w-10 items-center justify-center border border-white/20 bg-transparent text-white/60 transition-colors hover:border-white/40 hover:text-white focus:outline-none focus:ring-2 focus:ring-neon-green focus:ring-offset-2 focus:ring-offset-dark-bg disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="Go to next page"
      >
        <ChevronRightIcon />
      </button>
    </nav>
  );
}

function ChevronLeftIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
