import type { Env } from "./types";
import { handleGenerate } from "./routes/generate";
import { handleSummary } from "./routes/summary";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/generate" && req.method === "POST") {
      return handleGenerate(req, env, ctx);
    }
    if (url.pathname === "/api/summary" && req.method === "GET") {
      return handleSummary(req, env);
    }
    if (url.pathname.startsWith("/api/")) {
      return new Response("Not Found", { status: 404 });
    }

    // 非 API：交给静态资源（前端构建产物）。
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
