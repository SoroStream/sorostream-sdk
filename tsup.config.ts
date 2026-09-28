import { defineConfig } from 'tsup';

// Issue #619: ship modern output instead of down-levelled/polyfilled code.
// - `target: 'es2022'` stops esbuild from injecting helpers for syntax every
//   supported runtime (Node 18+, evergreen browsers) already understands.
// - `shims: false` avoids injecting `import.meta.url` / `__dirname` shims.
// - Dependencies stay external so consumers' bundlers decide what, if any,
//   polyfills their own target environments need.
export default defineConfig({
  target: 'es2022',
  shims: false,
  treeshake: true,
  splitting: false,
});
