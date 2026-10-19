/**
 * Regression test for #1336.
 *
 * handleConfirm went straight from SIGNING to SUCCESS as soon as onConfirm
 * resolved, but every caller signs *and* submits inside onConfirm. The
 * SUBMITTING state was therefore defined but never set, so the modal showed
 * "Please approve the transaction in Freighter" for the whole multi-second
 * on-chain confirmation wait — long after the user had approved.
 */
import React from "react";
import { act, render, screen, fireEvent } from "@testing-library/react";

import { TransactionModal, type TransactionProgress } from "../TransactionModal";

jest.mock("@/shared-d/utils/stellar-transactions", () => ({
    parseStellarError: (err: unknown) => String(err),
}));

const details = [{ label: "Entry Fee", value: "100 USDC" }];

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function renderModal(onConfirm: (progress: TransactionProgress) => Promise<void>) {
    return render(
        <TransactionModal
            isOpen
            onClose={jest.fn()}
            title="Join Arena"
            details={details}
            onConfirm={onConfirm}
        />,
    );
}

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

async function clickApproveAndFinishSigningDelay() {
    fireEvent.click(screen.getByText("Approve Transaction"));
    // The modal holds SIGNING for 500ms before awaiting onConfirm.
    await act(async () => {
        jest.advanceTimersByTime(500);
    });
}

describe("TransactionModal submitting state (#1336)", () => {
    it("shows the submitting copy after signing while a slow onConfirm is still confirming", async () => {
        const submission = deferred<void>();
        const onConfirm = jest.fn(async ({ onSigned }: TransactionProgress) => {
            onSigned();
            await submission.promise;
        });

        renderModal(onConfirm);
        await clickApproveAndFinishSigningDelay();

        expect(screen.getByText("Submitting...")).toBeInTheDocument();
        expect(screen.getByText("Waiting for network confirmation")).toBeInTheDocument();
        expect(screen.queryByText("Check your wallet")).not.toBeInTheDocument();
        expect(screen.queryByText("Success!")).not.toBeInTheDocument();

        await act(async () => {
            submission.resolve();
        });

        expect(screen.getByText("Success!")).toBeInTheDocument();
    });

    it("still shows the wallet-approval copy before signing completes", async () => {
        const signing = deferred<void>();
        const onConfirm = jest.fn(async ({ onSigned }: TransactionProgress) => {
            await signing.promise;
            onSigned();
        });

        renderModal(onConfirm);
        await clickApproveAndFinishSigningDelay();

        expect(screen.getByText("Check your wallet")).toBeInTheDocument();
        expect(screen.getByText("Please approve the transaction in Freighter")).toBeInTheDocument();

        await act(async () => {
            signing.resolve();
        });

        expect(screen.getByText("Success!")).toBeInTheDocument();
    });

    it("surfaces a submission failure as the error state", async () => {
        const onConfirm = jest.fn(async ({ onSigned }: TransactionProgress) => {
            onSigned();
            throw new Error("tx failed");
        });

        renderModal(onConfirm);
        await clickApproveAndFinishSigningDelay();

        expect(screen.getByText("Failed")).toBeInTheDocument();
        expect(screen.getByText(/tx failed/)).toBeInTheDocument();
    });
});
