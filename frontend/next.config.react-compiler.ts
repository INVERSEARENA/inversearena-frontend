// #1833: Adopt React Compiler and remove redundant manual memoization
// Add to next.config.ts:
//
// const withReactCompiler = require('babel-plugin-react-compiler/next');
// const nextConfig = {
//   experimental: {
//     reactCompiler: true,
//   },
// };
//
// module.exports = withReactCompiler(nextConfig);
//
// This enables automatic memoization of components and functions,
// removing the need for manual useMemo, useCallback, and memo() calls.
export const reactCompilerConfig = {
  experimental: {
    reactCompiler: true,
  },
}
