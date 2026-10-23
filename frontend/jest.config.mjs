import nextJest from 'next/jest.js';

const createJestConfig = nextJest({
    // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
    dir: './',
});

// Add any custom config to be passed to Jest
/** @type {import('jest').Config} */
const config = {
    setupFiles: ['<rootDir>/jest.setup.env.ts'],
    setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
    testEnvironment: 'jest-environment-jsdom',
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^@creit-tech/stellar-wallets-kit$': '<rootDir>/src/__mocks__/stellar-wallets-kit.ts',
    },
    testMatch: ['**/__tests__/**/*.test.[jt]s?(x)'],
};

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async.
// next-intl and its ICU deps ship ESM-only builds, so they must be excluded
// from transformIgnorePatterns for `useTranslations` to work in Jest (#1575).
const nextConfigFactory = createJestConfig(config);
const jestConfig = async () => {
    const resolved = typeof nextConfigFactory === 'function' ? await nextConfigFactory() : await nextConfigFactory;
    return {
        ...resolved,
        transformIgnorePatterns: [
            // next-intl and its ICU deps ship ESM-only builds: they (and
            // geist) must be transformed, everything else in node_modules
            // stays untouched (#1575).
            '/node_modules/(?!.*(geist|next-intl|use-intl|intl-messageformat|intl-localematcher|@formatjs))',
            '^.+\\.module\\.(css|sass|scss)$',
        ],
    };
};
export default jestConfig;
