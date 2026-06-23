/* Runtime configuration (editable via localhost /config). Pure data + defaults. */

export interface AppConfig {
  folders: string[]; // collection/favorites folder URLs to watch
  notion: { token: string; databaseId: string };
  schedule: { enabled: boolean; intervalMin: number; perRun: number };
  asr: { model: string };
}

export const DEFAULT_CONFIG: AppConfig = {
  folders: ["https://www.douyin.com/user/self?showTab=favorite_collection"],
  // databaseId prefilled with the DB created during setup; token left empty until
  // the user creates a Notion integration and shares the DB with it.
  notion: { token: "", databaseId: "c3be64840d2f435ebe8f90ff137a9830" },
  schedule: { enabled: false, intervalMin: 60, perRun: 10 },
  asr: { model: "turbo" },
};

/** Shallow-merge a patch onto a config (one level deep for the nested groups). */
export function mergeConfig(base: AppConfig, patch: Partial<AppConfig>): AppConfig {
  return {
    folders: patch.folders ?? base.folders,
    notion: { ...base.notion, ...patch.notion },
    schedule: { ...base.schedule, ...patch.schedule },
    asr: { ...base.asr, ...patch.asr },
  };
}
