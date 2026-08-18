/**
 * Host job store: the authoritative file-backed ledger at
 * `<dsh home>/timer-agent/jobs.json` (hermes-agent cron keeps its jobs at
 * ~/.hermes/cron/jobs.json — same shape of guarantee: the host process can
 * read/write it at any time, browser or not).
 *
 * All mutations serialize through one in-process promise chain; the file is
 * written atomically (temp + rename). Validation/repair reuses the pure
 * {@link parseLedger} from the shared core so a corrupted file degrades to
 * dropping invalid rows, never to a crashed ticker.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseLedger } from '../core/store.ts'
import type { JobRecord } from '../core/jobs.ts'

/** Default ledger location: ~/.dsh/timer-agent/jobs.json. */
export function defaultJobsFile(): string {
  return join(homedir(), '.dsh', 'timer-agent', 'jobs.json')
}

/**
 * File-backed job ledger. `load()` re-reads from disk (cheap, small file) so
 * concurrent writers (tool, routes, ticker) in this process stay coherent
 * through the single mutation chain.
 */
export class HostJobStore {
  private chain: Promise<unknown> = Promise.resolve()

  /**
   * @param file - absolute ledger path (tests inject a temp file).
   */
  constructor(private readonly file: string = defaultJobsFile()) {}

  /** Read the ledger (empty on first run / unreadable file). */
  async load(): Promise<JobRecord[]> {
    try {
      const raw = await readFile(this.file, 'utf8')
      return parseLedger(raw)
    } catch {
      // Missing file (first run) or unreadable: start empty, never throw —
      // the ticker must survive a damaged ledger.
      return []
    }
  }

  /**
   * Mutate the ledger under the serialization chain: load → mutate → atomic
   * save. The mutator returns undefined to abort (no write happens).
   * @param mutate - pure transform of the current ledger.
   * @returns the mutator's result (or undefined when it aborted).
   */
  async mutate<T>(mutate: (jobs: JobRecord[]) => { jobs: JobRecord[]; result: T } | undefined): Promise<T | undefined> {
    const run = async (): Promise<T | undefined> => {
      const current = await this.load()
      const outcome = mutate(current)
      if (outcome === undefined) return undefined
      await this.save(outcome.jobs)
      return outcome.result
    }
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => undefined)
    return next
  }

  /** Atomic write: temp file in the same directory, then rename. */
  private async save(jobs: readonly JobRecord[]): Promise<void> {
    const dir = join(this.file, '..')
    await mkdir(dir, { recursive: true })
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temp, `${JSON.stringify(jobs, null, 2)}\n`, 'utf8')
    await rename(temp, this.file)
  }
}
