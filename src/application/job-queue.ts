/* Generic single-worker queue with positions. Framework-free; the processor is injected. */

export type JobStatus = "queued" | "running" | "done" | "error";

export interface Job<R> {
  id: string;
  input: string;
  status: JobStatus;
  result?: R;
  error?: string;
  errorKind?: string; // classified bucket (e.g. notoken/captcha/unsupported) for UI routing
  log: string[];
}

export class JobQueue<R> {
  private jobs = new Map<string, Job<R>>();
  private queue: Job<R>[] = [];
  private working = false;
  private seq = 0;

  // ponytail: serial worker — the browser session and the CPU/ASR are single-tenant.
  // Per-token parallel workers are the upgrade path if throughput matters.
  // classifyError is injected (compose knows the domain error classes; this stays generic).
  constructor(
    private process: (input: string, log: (m: string) => void) => Promise<R>,
    private classifyError?: (e: unknown) => string | undefined,
  ) {}

  submit(input: string): Job<R> {
    const job: Job<R> = { id: String(++this.seq), input, status: "queued", log: [] };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    void this.tick();
    return job;
  }

  get(id: string): Job<R> | undefined { return this.jobs.get(id); }

  /** position 1 = being processed now; ahead = jobs that run before this one. */
  position(id: string): { position?: number; ahead?: number } {
    const job = this.jobs.get(id);
    if (!job) return {};
    if (job.status === "running") return { position: 1, ahead: 0 };
    if (job.status === "queued") {
      const ahead = this.queue.indexOf(job) + (this.working ? 1 : 0);
      return { position: ahead + 1, ahead };
    }
    return {};
  }

  private async tick(): Promise<void> {
    if (this.working) return;
    this.working = true;
    while (this.queue.length) {
      const job = this.queue.shift()!;
      job.status = "running";
      try {
        job.result = await this.process(job.input, (m) => job.log.push(m));
        job.status = "done";
      } catch (e) {
        job.status = "error";
        job.error = e instanceof Error ? e.message : String(e);
        job.errorKind = this.classifyError?.(e);
      }
    }
    this.working = false;
  }
}
