export interface AwemeListItem {
  awemeId: string;
  desc: string;
  author: string;
}

export interface TranscriptResult {
  awemeId: string;
  title: string;
  author: string;
  shareUrl: string;
  text: string;
  method: "caption";
}
