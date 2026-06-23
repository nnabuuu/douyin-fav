import type { Analyzer } from "../domain/ports.js";
import type { VideoResult } from "../domain/model.js";

/**
 * Passthrough analyzer — stores the raw transcript as-is (this period: no LLM).
 * ponytail: the seam exists so an AnthropicAnalyzer (clean ASR typos + summarize)
 * drops in later without touching the pipeline. Not built now by decision.
 */
export class RawAnalyzer implements Analyzer {
  async analyze(result: VideoResult): Promise<{ cleaned: string; summary?: string }> {
    return { cleaned: result.transcript };
  }
}
