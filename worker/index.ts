// Cloudflare Worker entry: POST /v1/systemone -> handleRequest().

import { handleRequest } from "../src/http.ts";

export default {
  async fetch(request: Request, env: Record<string, string | undefined>): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/systemone") {
      return Response.json({ error: { message: "not found" } }, { status: 404 });
    }
    return handleRequest(request, {
      apiKey: env.DEEPSEEK_API_KEY,
      baseUrl: env.DEEPSEEK_BASE_URL,
      model: env.DEEPSEEK_MODEL,
    });
  },
};
