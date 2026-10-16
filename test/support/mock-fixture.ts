/**
 * One mock library, on a port the OS chose — the fixture every browser-driven test starts.
 *
 * ## Why this exists
 *
 * Every one of these files used to do it itself:
 *
 * ```ts
 * const PORT = 4615;                                  // pager.test.ts
 * const mock = spawn(process.execPath, ['tools/mock-subsonic.mjs', '--port', String(PORT), '--stress']);
 * ```
 *
 * Two files that hard-code the *same* port do not collide loudly. The second mock dies of
 * `EADDRINUSE` before it can answer anything; the first one answers the second file's readiness probe,
 * because `/rest/ping.view` is identical in both — so the file whose mock lost the race drives its
 * whole run against a library that belongs to another test. And when that other test finishes, it
 * SIGKILLs its own mock, leaving a dark port under a harness that still has minutes to run.
 *
 * That is exactly what t_744cba0b was. `test/pager.test.ts` and `test/palette-apply.test.ts` both
 * asked for **4615**; `test/palette-apply.test.ts` finishes in ~3 s (measured) and the pager test runs
 * for ~36 s (measured), so whenever palette-apply's mock won the bind, its own `finally` SIGKILLed the
 * library the pager check was driving within the first seconds of that run. The two checks that read
 * the audio's own numbers went red from there, and step 9 of `tools/pager-check.mjs` — which navigates
 * to `#/album/album-ja-1` and needs a fresh API answer for the page to draw — threw, taking the rest
 * of the run with it:
 *
 * ```
 * ✖ the swipe pager pulls its panes, and never takes a scroll
 *   FAIL  the run reached the end of its checks
 *     - the run reached the end of its checks — page threw: Error: timed out waiting for the stress album
 * ```
 *
 * The 20 s patience in that wait was never the problem — a longer one fails too, because the library
 * is gone. Reproduced by hand, with the library's own request log as the evidence:
 * docs/verification.md §21.
 *
 * ## What it does instead
 *
 * `--port 0` asks the OS, and `tools/mock-subsonic.mjs` prints the port it actually bound *from its
 * listen callback*, so this fixture knows the child it spawned is the one listening — there is nothing
 * to race with a sibling test. The child's own stdout and stderr are kept, and a mock that never
 * reaches "listening" (a bad flag, a crash, a port taken by something outside the suite) fails here in
 * milliseconds, naming the child's own output, instead of surfacing forty seconds later as a harness
 * timeout with no cause.
 *
 * `test/support/` is not part of the `test/*.test.ts` glob, so this file is a helper, not a test.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface MockLibrary {
  /** The port the OS gave the mock. Every URL in the test is built from this. */
  readonly port: number;
  /** `http://127.0.0.1:<port>` — the origin that serves both the API and the built app. */
  readonly base: string;
  /** Everything the mock has printed so far. */
  output(): string;
  /** SIGKILL the mock. Safe to call twice. */
  stop(): void;
}

export interface StartMockOptions {
  /** `--stress`: the long Japanese/unbroken-name library the layout and gesture checks are about. */
  stress?: boolean;
  /** `--dist <dir>`: serve the built app from here. Defaults to the mock's own. */
  dist?: string;
  /** Extra flags, passed through as given: `['--user', U, '--password', P]`. */
  extra?: string[];
  /** How long to wait for the mock to report a port. */
  timeoutMs?: number;
}

// `test/support/…` → the repository root, which is where `tools/` and `dist/` live.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT_LINE = /^navilite-mock-port (\d+)$/m;

export async function startMockLibrary(options: StartMockOptions = {}): Promise<MockLibrary> {
  const argv = ['tools/mock-subsonic.mjs', '--port', '0'];
  if (options.stress) argv.push('--stress');
  if (options.dist) argv.push('--dist', options.dist);
  if (options.extra) argv.push(...options.extra);

  const child = spawn(process.execPath, argv, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `the mock library did not report a port within ${options.timeoutMs ?? 15_000} ms — its output so far:\n${output || '(nothing)'}`,
        ),
      );
    }, options.timeoutMs ?? 15_000);

    const scan = (chunk: Buffer): void => {
      output += String(chunk);
      const match = PORT_LINE.exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    };

    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`the mock library could not be started: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `the mock library exited (${signal ?? `code ${code}`}) before it was listening — its output:\n${output || '(nothing)'}`,
        ),
      );
    });
  });

  const base = `http://127.0.0.1:${port}`;

  // The port line is printed from the listen callback, so the OS has the socket; one read of the
  // mock's own state proves the process is still alive and answering, which is the contract the
  // callers actually need. `/__state` is a debug route served before any credentials are looked at,
  // so this probe does not care which `--user`/`--password` a caller asked for.
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const response = await fetch(`${base}/__state`);
      if (response.ok) break;
    } catch {
      /* not answering yet, or already gone */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`the mock library reported port ${port} but never answered on it — its output:\n${output || '(nothing)'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    port,
    base,
    output: () => output,
    stop: () => child.kill('SIGKILL'),
  };
}
