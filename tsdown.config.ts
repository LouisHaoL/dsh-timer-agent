import { defineConfig } from 'tsdown'

/**
 * Build both plugin halves:
 * - lib/index.js + lib/invariant.js (host entry, node-facing)
 * - lib/client.js (browser entry) — the dsh client-module bundle shape: a
 *   classic script that only REGISTERS its factory via
 *   window.__ModuleLoader__.load({ id, factory }); platform deps resolve
 *   through the injected `require` (the loader's frozen module table), never
 *   through ESM imports. Mirrors the shared preset in the dsh repo
 *   (packages/client/tsdown.client.ts): format cjs + banner/intro/footer
 *   wrapper, externals limited to module-table seed ids.
 */
const jsExtensions = () => ({ js: '.js' as const, dts: '.d.ts' as const })

/**
 * Module-table seed ids this bundle may require (the dsh browser platform
 * list, restricted to what src/client actually imports). Everything else
 * inlines — a require the table cannot answer is a guaranteed runtime throw.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
] as const

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/invariant.ts'],
    outDir: 'lib',
    format: 'esm',
    dts: true,
    platform: 'node',
    outExtensions: jsExtensions,
    deps: {
      neverBundle: [
        '@deepseek-ai/cordis',
        '@deepseek-ai/cosmokit',
        '@deepseek-ai/schemastery',
        'schemastery',
        '@deepseek-ai/dsh-settings',
        '@deepseek-ai/dsh-system-prompt',
        '@deepseek-ai/dsh-tools',
        '@deepseek-ai/dsh-scope',
        '@deepseek-ai/dsh-timeout',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-session',
      ],
    },
  },
  {
    name: 'dsh-timer-agent/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    // The dsh web shell serves /plugins/dsh-timer-agent/client.js as an
    // external classic script; the bundle must register a factory, not run
    // its module body at script-execution time. CSS injection therefore also
    // lives inside the factory (scripts/inline-css.mjs inserts it before the
    // footer) so it runs at materialization and HMR can own the style tag.
    format: 'cjs',
    platform: 'browser',
    // dts must stay off: declaration emit would wrap the banner/footer into
    // the .d.ts and break parsing (types are not consumed from this bundle).
    dts: false,
    outExtensions: jsExtensions,
    sourcemap: true,
    deps: {
      neverBundle: [...CLIENT_EXTERNALS],
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-timer-agent", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
