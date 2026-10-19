/**
 * Regression test for #1341.
 *
 * `searchInput` used to be seeded from the URL's `q` param on first mount only,
 * so it never re-synced when the URL changed for any other reason. After typing
 * a term and pressing browser Back the results correctly unfiltered but the box
 * still displayed the old term — and the next keystroke re-applied that stale
 * filter through the debounce effect.
 */
import React from "react";
import { act, render, screen, fireEvent } from "@testing-library/react";

import { GamesFilters } from "../GamesFilters";

let currentSearchParams = new URLSearchParams();
const replace = jest.fn();

jest.mock("next/navigation", () => ({
    useRouter: () => ({ replace }),
    usePathname: () => "/games",
    useSearchParams: () => currentSearchParams,
}));

function setUrlQuery(query: string) {
    currentSearchParams = new URLSearchParams(query);
}

beforeEach(() => {
    jest.useFakeTimers();
    replace.mockClear();
    setUrlQuery("");
});

afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
});

function searchBox() {
    return screen.getByPlaceholderText("FILTER_BY_ID") as HTMLInputElement;
}

describe("GamesFilters search/URL sync (#1341)", () => {
    it("seeds the search box from the URL on mount", () => {
        setUrlQuery("q=alpha");
        render(<GamesFilters />);

        expect(searchBox().value).toBe("alpha");
    });

    it("does not clear an already-applied q while the debounce catches up", () => {
        setUrlQuery("q=alpha");
        render(<GamesFilters />);

        act(() => {
            jest.advanceTimersByTime(1000);
        });

        expect(replace).not.toHaveBeenCalled();
        expect(searchBox().value).toBe("alpha");
    });

    it("resyncs the search box when the URL changes from outside the input", () => {
        setUrlQuery("q=alpha");
        const { rerender } = render(<GamesFilters />);
        expect(searchBox().value).toBe("alpha");

        // Simulate browser Back: the URL loses `q` without the input driving it.
        setUrlQuery("");
        rerender(<GamesFilters />);

        expect(searchBox().value).toBe("");
    });

    it("does not re-apply the stale term after a back navigation and a new keystroke", () => {
        setUrlQuery("q=alpha");
        const { rerender } = render(<GamesFilters />);

        setUrlQuery("");
        rerender(<GamesFilters />);

        fireEvent.change(searchBox(), { target: { value: "b" } });
        act(() => {
            jest.advanceTimersByTime(1000);
        });

        expect(searchBox().value).toBe("b");
        expect(replace).toHaveBeenCalledWith("/games?q=b", { scroll: false });
    });

    it("pushes the debounced term into the URL when the user types", () => {
        render(<GamesFilters />);

        fireEvent.change(searchBox(), { target: { value: "alpha" } });
        expect(replace).not.toHaveBeenCalled();

        act(() => {
            jest.advanceTimersByTime(500);
        });

        expect(replace).toHaveBeenCalledWith("/games?q=alpha", { scroll: false });
    });
});
