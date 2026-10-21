/// <reference types="vite/client" />

/**
 * The git commit this bundle was built from, stamped by `vite.config.ts`'s `define`
 * (`tools/build-id.ts`). The Settings → About line prints it, and without the define it shipped the
 * literal placeholder — which is why `test/build-id.test.ts` fails on a bundle that still has one.
 */
declare const __BUILD_ID__: string;
