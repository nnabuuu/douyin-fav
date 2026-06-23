import { compose } from "./compose.js";
import { createHttp } from "./delivery/http.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";

const { jobs, admin, config, sync, analyzer, exporter, systemCheck, gateway } = compose();
const server = createHttp({ jobs, admin, config, sync, analyzer, exporter, systemCheck });

server.listen(PORT, HOST, () => {
  const host = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`服务 → http://${host}:${PORT}  ·  配置 → http://${host}:${PORT}/config`);
  if (!process.env.TOKEN) console.log("（无 TOKEN:同网段任何人可用。门禁:TOKEN=xxx npm run serve）");
  if (config.get().schedule.enabled) { sync.start(); console.log("定时同步已开启(config.schedule.enabled=true)。"); }
  else console.log("定时同步未开启(/config 里设 schedule.enabled=true,或点“开启定时”)。");
});

const bye = async () => { await gateway.closeAll(); process.exit(0); };
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
