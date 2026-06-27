// esbuild entry for the vendored WalletConnect SignClient.
//
// WHY THIS FILE: an MV3 extension page can only `import()` a SAME-ORIGIN ESM (CSP
// `script-src 'self'`), and the repo has no app bundler. This single entry is bundled by
// scripts/bundle-walletconnect.js into vendor/walletconnect-sign-client.js — one self-
// contained ESM that wallet-wc.js imports at runtime. It re-exports SignClient as BOTH the
// default and a named export so wallet-wc.js's `mod.default || mod.SignClient || mod`
// resolves regardless of how esbuild names it.
import SignClient from '@walletconnect/sign-client';

export default SignClient;
export { SignClient };
