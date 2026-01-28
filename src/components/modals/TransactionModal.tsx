"use client";

import { useState, useCallback, useEffect } from "react";
import { Modal } from "@/components/ui/Modal";

export type TransactionState = "REVIEW" | "SIGNING" | "SUBMITTING" | "SUCCESS" | "ERROR";

interface TransactionDetail {
    label: string;
    value: string | number;
    isImportant?: boolean;
}

interface TransactionModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    description?: string;
    details: TransactionDetail[];
    onConfirm: () => Promise<void>;
    confirmLabel?: string;
}

export function TransactionModal({
    isOpen,
    onClose,
    title,
    description,
    details,
    onConfirm,
    confirmLabel = "Approve Transaction",
}: TransactionModalProps) {
    const [state, setState] = useState<TransactionState>("REVIEW");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    // Reset state when modal opens
    useEffect(() => {
        if (isOpen) {
            setState("REVIEW");
            setErrorMessage(null);
        }
    }, [isOpen]);

    const handleConfirm = useCallback(async () => {
        try {
            setState("SIGNING");
            // Give a small delay to show state change or await actual wallet interaction
            await new Promise(r => setTimeout(r, 500));

            // Call the actual confirm handler (which triggers wallet sign)
            await onConfirm();

            // If we get here, we assume it's submitting or done. 
            // The caller might handle the actual submission and state updates, but if `onConfirm` resolves, 
            // we usually consider it submitted. 
            // However, if onConfirm involves the whole flow including submission, it might take time.
            // Let's assume onConfirm resolves when the txn is successfully submitted on-chain or at least sent.
            setState("SUCCESS");
        } catch (err) {
            console.error("Transaction failed:", err);
            setState("ERROR");
            setErrorMessage(err instanceof Error ? err.message : "Transaction failed");
        }
    }, [onConfirm]);

    const isProcessing = state === "SIGNING" || state === "SUBMITTING";

    const renderContent = () => {
        switch (state) {
            case "REVIEW":
                return (
                    <>
                        <div className="space-y-4 mb-8">
                            {details.map((detail, index) => (
                                <div key={index} className="flex justify-between items-center border-b border-white/10 pb-2">
                                    <span className="text-slate-400 font-bold uppercase text-sm tracking-wide">
                                        {detail.label}
                                    </span>
                                    <span className={`font-black text-lg ${detail.isImportant ? "text-primary" : "text-white"}`}>
                                        {detail.value}
                                    </span>
                                </div>
                            ))}
                        </div>

                        <div className="flex gap-4">
                            <button
                                onClick={onClose}
                                className="flex-1 border-2 border-white/20 py-4 font-black uppercase tracking-widest text-white hover:bg-white/10 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirm}
                                className="flex-1 bg-primary text-black border-2 border-black py-4 font-black uppercase tracking-widest hover:translate-y-[-2px] hover:shadow-[4px_4px_0px_0px_#fff] transition-all"
                            >
                                {confirmLabel}
                            </button>
                        </div>
                    </>
                );

            case "SIGNING":
            case "SUBMITTING":
                return (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                        <div className="relative size-24 mb-6">
                            <span className="material-symbols-outlined text-6xl text-primary animate-spin">
                                cached
                            </span>
                        </div>
                        <h3 className="text-2xl font-black uppercase italic text-white mb-2">
                            {state === "SIGNING" ? "Check your wallet" : "Submitting..."}
                        </h3>
                        <p className="text-slate-400 font-medium">
                            {state === "SIGNING"
                                ? "Please approve the transaction in Freighter"
                                : "Waiting for network confirmation"}
                        </p>
                    </div>
                );

            case "SUCCESS":
                return (
                    <div className="flex flex-col items-center justify-center py-8 text-center">
                        <div className="size-20 bg-green-500 rounded-full flex items-center justify-center mb-6 text-black border-4 border-black">
                            <span className="material-symbols-outlined text-5xl font-bold">check</span>
                        </div>
                        <h3 className="text-3xl font-black uppercase italic text-green-500 mb-2">
                            Success!
                        </h3>
                        <p className="text-slate-400 font-medium mb-8">
                            Transaction has been confirmed on the network.
                        </p>
                        <button
                            onClick={onClose}
                            className="w-full bg-white text-black border-2 border-black py-4 font-black uppercase tracking-widest hover:bg-slate-200 transition-colors"
                        >
                            Close
                        </button>
                    </div>
                );

            case "ERROR":
                return (
                    <div className="flex flex-col items-center justify-center py-8 text-center">
                        <div className="size-20 bg-red-500 rounded-full flex items-center justify-center mb-6 text-black border-4 border-black">
                            <span className="material-symbols-outlined text-5xl font-bold">priority_high</span>
                        </div>
                        <h3 className="text-3xl font-black uppercase italic text-red-500 mb-2">
                            Failed
                        </h3>
                        <p className="text-white font-medium mb-6">
                            {errorMessage}
                        </p>
                        <div className="flex gap-4 w-full">
                            <button
                                onClick={onClose}
                                className="flex-1 border-2 border-white/20 py-4 font-black uppercase tracking-widest text-white hover:bg-white/10 transition-colors"
                            >
                                Close
                            </button>
                            <button
                                onClick={() => setState("REVIEW")}
                                className="flex-1 bg-red-500 text-black border-2 border-black py-4 font-black uppercase tracking-widest hover:brightness-110 transition-all"
                            >
                                Retry
                            </button>
                        </div>
                    </div>
                );
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={() => !isProcessing && onClose()}
            size="md"
            position="center"
            ariaLabel={title}
            closeOnOverlayClick={!isProcessing}
            closeOnEscape={!isProcessing}
            className="bg-[#0F172A]! border-3 border-black rounded-none!"
        >
            <div className="p-6 lg:p-8 font-display">
                {/* Header */}
                <div className="mb-6">
                    <div className="flex items-center gap-3 mb-2">
                        <span className="material-symbols-outlined text-primary text-3xl">
                            {state === "SUCCESS" ? "verified" : state === "ERROR" ? "error" : "receipt_long"}
                        </span>
                        <h2 className="text-3xl font-black tracking-tighter uppercase italic leading-none text-white">
                            {title}
                        </h2>
                    </div>
                    {description && (
                        <p className="text-slate-400 font-bold text-xs uppercase tracking-widest border-l-2 border-primary pl-3">
                            {description}
                        </p>
                    )}
                </div>

                {renderContent()}
            </div>
        </Modal>
    );
}
