'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Modal } from '../../ui/Modal';
import { Zap, Share2, ActivitySquare } from 'lucide-react';

interface PoolSuccessModalProps {
    isOpen: boolean;
    onClose: () => void;
    arenaId: string;
    stakeThreshold: number;
    rwaYieldLock: string | number;
    deploymentTime?: number;
    yieldRate: number;
    changeSync: boolean;
    onEnterCommandCenter?: () => void;
    onShareLink?: () => void;
}

interface DeploymentLog {
    label: string;
    status: 'OK' | 'PENDING';
}

const DeploymentLogs: React.FC = () => {
    const logs: DeploymentLog[] = [
        { label: 'ORACLE_CONNECTIVITY....', status: 'OK' },
        { label: 'STAKE_THRESHOLD_VALIDATION', status: 'OK' },
        { label: 'PAYMENT_GATEWAY_SYNC', status: 'OK' },
        { label: 'NETWORK_CONSENSUS', status: 'OK' },
    ];

    const containerVariants = {
        hidden: { opacity: 0 },
        visible: {
            opacity: 1,
            transition: {
                staggerChildren: 0.1,
                delayChildren: 0.3,
            },
        },
    };

    const logVariants = {
        hidden: { opacity: 0, x: -10 },
        visible: { opacity: 1, x: 0 },
    };

    return (
        <motion.div
            className="font-mono text-sm"
            variants={containerVariants}
            initial="hidden"
            animate="visible"
        >
            {logs.map((log, idx) => (
                <motion.div key={idx} variants={logVariants} className="flex items-center gap-2 py-1">
                    <span className={`${idx <= 1 ? "text-[#00FF00]" : "text-gray-400"}`}>[OK]</span>
                    <span className={`${idx <= 1 ? "text-[#00FF00]" : "text-gray-400"} text-xs`}>{log.label}</span>
                </motion.div>
            ))}
        </motion.div>
    );
};

interface IdentityPlateProps {
    arenaId: string;
    stakeThreshold: number;
    rwaYieldLock: string | number;
    yieldRate: number;
    changeSync: boolean;
}

const IdentityPlate: React.FC<IdentityPlateProps> = ({
    arenaId,
    stakeThreshold,
    rwaYieldLock,
    changeSync,
    yieldRate
}) => {
    const containerVariants = {
        hidden: { opacity: 0, scale: 0.95 },
        visible: { opacity: 1, scale: 1 },
    };

    const itemVariants = {
        hidden: { opacity: 0, y: 5 },
        visible: { opacity: 1, y: 0 },
    };

    return (
        <motion.div
            className="bg-white text-black border-4 border-black p-6"
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            transition={{ delay: 0.2, duration: 0.5 }}
        >
            <motion.div variants={itemVariants} className="mb-3">
                <p className="text-xs font-bold text-gray-600 mb-2">
                    ARENA_IDENTITY_PLATE
                </p>
                <p className="text-3xl font-bold text-black">{arenaId}</p>
            </motion.div>
            <hr className='text-black bg-black h-0.5' />
            <motion.div
                className="space-y-4 gap-4"
                variants={{
                    hidden: { opacity: 0 },
                    visible: {
                        opacity: 1,
                        transition: {
                            staggerChildren: 0.1,
                            delayChildren: 0.4,
                        },
                    },
                }}
                initial="hidden"
                animate="visible"
            >
                <div className='flex justify-between items-center mt-3'>
                    <p className="text-[10px] font-bold tracking-widest text-gray-600">
                        STAKE_THRESHOLD
                    </p>
                    <p className="text-[10px] font-bold border-2 py-px px-2 bg-[#00FF00]">{stakeThreshold}</p>
                </div>

                <div className='flex justify-between items-center'>
                    <p className="text-[10px] font-bold tracking-widest text-gray-600 mb-1">
                        RWA_YIELD_LOCK
                    </p>
                    <p className="text-[10px] font-bold  py-px px-2 bg-[#000000] text-white">{rwaYieldLock}</p>
                </div>

                <div className='flex justify-between items-center mt'>
                    <p className="text-[10px] font-bold tracking-widest text-gray-600">
                        CHANGE_SYNC
                    </p>
                    <p className="text-[10px] font-bold border-2 py-px px-2 bg-[#00FF00]">{changeSync ? "TRUE" : "FALSE"}</p>
                </div>

                <div className='flex justify-between items-center'>
                    <p className="text-[10px] font-bold tracking-widest text-gray-600 mb-1">
                        YIELD_RATE
                    </p>
                    <p className="text-[10px] font-bold  py-px px-2 bg-[#000000] text-white">{yieldRate}%</p>
                </div>
            </motion.div>

            <motion.div
                className="border-t-2 border-gray-300 mt-4 pt-3"
                variants={itemVariants}
                transition={{ delay: 0.5 }}
            >
                <p className="text-xs text-gray-500 font-mono">
                    STATUS: ACTIVE • DEPLOYMENT: OK
                </p>
            </motion.div>
        </motion.div>
    );
};

const PoolSuccessModal: React.FC<PoolSuccessModalProps> = ({
    isOpen,
    onClose,
    arenaId,
    stakeThreshold,
    rwaYieldLock,
    changeSync,
    yieldRate,
    deploymentTime = new Date().getTime(),
    onEnterCommandCenter,
    onShareLink,
}) => {
    const [displayedTime, setDisplayedTime] = useState<string>('99.999%');

    useEffect(() => {
        if (isOpen) {
            const uptime = (99.9 + Math.random() * 0.099).toFixed(3);
            setDisplayedTime(uptime + '%');
        }
    }, [isOpen]);

    const containerVariants = {
        hidden: { opacity: 0 },
        visible: {
            opacity: 1,
            transition: {
                staggerChildren: 0.05,
            },
        },
    };

    const itemVariants = {
        hidden: { opacity: 0, y: 10 },
        visible: { opacity: 1, y: 0 },
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            size="lg"
            position="center"
            closeOnOverlayClick
            closeOnEscape
            className="rounded-none! pool-success-modal-scrollbar"
        >
            <motion.div
                className="relative w-full bg-[#131810] text-[#00FF00] border-4 border-[#000000] overflow-hidden"
                style={{
                    backgroundSize: '40px 40px',
                }}
                variants={containerVariants}
                initial="hidden"
                animate="visible"
            >
                <div className="max-w-2xl">
                    {/* Header */}
                    <motion.div className="text-center p-4 md:p-6" variants={itemVariants}>
                        <p className="text-5xl md:text-6xl font-extrabold mb-1"
                            style={{ fontFamily: '"Courier New"' }}>
                            ARENA_ONLINE
                        </p>
                        <p className="text-xs font-mono font-bold tracking-widest text-[#00FF00] opacity-70">
                            DEPLOYMENT SUCCESS — STELLAR SOROBAN NETWORK
                        </p>
                    </motion.div>

                    <hr className='bg-black my-2 text-black h-1' />

                    {/* Main Content Grid */}
                    <motion.div
                        className="p-2 md:p-4 gap-8 mb-8"
                        variants={{
                            hidden: { opacity: 0 },
                            visible: {
                                opacity: 1,
                                transition: {
                                    staggerChildren: 0.1,
                                    delayChildren: 0.2,
                                },
                            },
                        }}
                        initial="hidden"
                        animate="visible"
                    >
                        <div className='flex flex-wrap md:flex-nowrap gap-3'>
                            <div className='flex-col w-full md:w-[65%] gap-3 space-y-4'>
                                <motion.div
                                    className="border-[6px] rounded-lg border-black p-4 bg-[#0a0e09]"
                                    variants={itemVariants}
                                >
                                    <div className='flex justify-between items-center mb-4'>
                                        <div className="flex gap-1 items-center">
                                            <ActivitySquare size={18} className="text-[#00FF00]" />
                                            <p className="text-sx font-mono italic font-extrabold tracking-widest text-white">
                                                SYSTEM_STABLE
                                            </p>
                                        </div>
                                        <p className="text-lg font-mono font-extrabold text-[#00FF00]">100%</p>
                                    </div>
                                    <div className="space-y-3">
                                        <div>
                                            <div className="w-full h-5 bg-gray-900 border border-[#00FF00]">
                                                <div
                                                    className="h-full bg-[#00FF00] transition-all duration-1000"
                                                    style={{ width: '100%' }}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                    <p className="text-xs font-mono text-[#00FF00] mt-4">
                                        INITIALIZATION_COMPLETE
                                    </p>
                                </motion.div>

                                {/* Validation Logs */}
                                <motion.div
                                    className="border-[6px] rounded-lg border-black p-4 bg-[#1f231d]"
                                    variants={itemVariants}
                                >
                                    <DeploymentLogs />
                                </motion.div>
                            </div>

                            {/* Identity Plate */}
                            <motion.div variants={itemVariants} className="w-full md:w-[35%]">
                                <IdentityPlate
                                    arenaId={arenaId}
                                    stakeThreshold={stakeThreshold}
                                    rwaYieldLock={rwaYieldLock}
                                    yieldRate={yieldRate}
                                    changeSync={changeSync}
                                />
                            </motion.div>
                        </div>
                    </motion.div>

                    {/* Action Buttons */}
                    <motion.div
                        className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8 p-2 md:p-4"
                        variants={{
                            hidden: { opacity: 0 },
                            visible: {
                                opacity: 1,
                                transition: {
                                    staggerChildren: 0.1,
                                    delayChildren: 0.5,
                                },
                            },
                        }}
                        initial="hidden"
                        animate="visible"
                    >
                        <motion.button
                            onClick={onEnterCommandCenter}
                            className="flex items-center justify-center gap-2 bg-[#00FF00] hover:bg-[#00DD00] text-black font-bold text-sm tracking-widest py-3 px-6 border-2 border-[#00FF00] transition-all active:scale-95"
                            variants={itemVariants}
                        >
                            ENTER_COMMAND_CENTER
                            <Zap fill='black' size={18} />
                        </motion.button>

                        <motion.button
                            onClick={onShareLink}
                            className="flex items-center justify-center gap-2 bg-white hover:bg-white/80 hover:bg-opacity-10 text-black font-bold text-sm tracking-widest py-3 px-6 transition-all active:scale-95"
                            variants={itemVariants}
                        >
                            SHARE_LINK
                            <Share2 size={18} />
                        </motion.button>
                    </motion.div>

                    {/* Footer */}
                    <motion.div
                        className="text-center border-t border-[#00FF00]/30 pt-6"
                        variants={itemVariants}
                        transition={{ delay: 0.6 }}
                    >
                        <p className="text-xs font-mono text-gray-500 text-center">
                            PROTOCOL: INVERSE_V2.01 • UP_TIME: {displayedTime}
                        </p>
                    </motion.div>
                </div>
            </motion.div>
        </Modal>
    );
};

export default PoolSuccessModal;