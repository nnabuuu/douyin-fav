import { videoUrl, type VideoResult } from "../domain/model.js";
import type { ConfigStore, Exporter } from "../domain/ports.js";

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

/**
 * Writes finished transcripts to a Notion database via REST.
 * Reads token + databaseId from config at call time (so /config edits take effect
 * without a restart). No token configured → a no-op that reports "skipped".
 * Idempotent by the `videoId` property.
 */
export class NotionExporter implements Exporter {
  constructor(private config: ConfigStore) {}

  private get creds() {
    const { token, databaseId } = this.config.get().notion;
    return { token: token.trim(), databaseId: databaseId.trim() };
  }

  private async api(path: string, body: unknown): Promise<any> {
    const { token } = this.creds;
    const resp = await fetch(API + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Notion ${resp.status}: ${text.slice(0, 300)}`);
    }
    return resp.json();
  }

  async has(videoId: string): Promise<boolean> {
    const { token, databaseId } = this.creds;
    if (!token || !databaseId) return false;
    const data = await this.api(`/databases/${databaseId}/query`, {
      filter: { property: "videoId", rich_text: { equals: videoId } },
      page_size: 1,
    });
    return Array.isArray(data.results) && data.results.length > 0;
  }

  async export(result: VideoResult, cleaned: string, summary: string | undefined): Promise<"created" | "skipped"> {
    const { token, databaseId } = this.creds;
    if (!token || !databaseId) return "skipped"; // not configured yet
    if (await this.has(result.videoId)) return "skipped";

    await this.api("/pages", {
      parent: { database_id: databaseId },
      icon: { type: "emoji", emoji: "🎬" },
      properties: {
        Name: { title: [{ text: { content: (result.title || result.videoId).slice(0, 200) } }] },
        videoId: { rich_text: [{ text: { content: result.videoId } }] },
        author: { rich_text: [{ text: { content: result.author || "" } }] },
        url: { url: videoUrl(result.platform, result.videoId) },
        platform: { select: { name: result.platform } },
        source: { select: { name: result.source } },
        date: { date: { start: today() } },
      },
      children: buildChildren(result.desc, cleaned, summary),
    });
    return "created";
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function para(content: string) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content } }] } };
}
function heading(content: string) {
  return { object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content } }] } };
}

/** Notion caps rich_text at 2000 chars/block and 100 children/request. Chunk + cap. */
function buildChildren(desc: string, cleaned: string, summary: string | undefined): unknown[] {
  const blocks: unknown[] = [];
  if (summary) { blocks.push(heading("要点"), para(summary.slice(0, 1900))); }
  if (desc) { blocks.push(heading("文案")); for (const c of chunk(desc)) blocks.push(para(c)); }
  blocks.push(heading("口播逐字稿"));
  for (const c of chunk(cleaned)) blocks.push(para(c));
  return blocks.slice(0, 95);
}

function chunk(s: string, size = 1900): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length ? out : [""];
}
