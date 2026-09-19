// Vercel Web handler: /v1/systemone is rewritten here by vercel.json.

import { handleRequest } from "../src/http.ts";

export default {
  fetch(request: Request): Promise<Response> {
    return handleRequest(request, {
      apiKey: process.env["DEEPSEEK_API_KEY"],
      baseUrl: process.env["DEEPSEEK_BASE_URL"],
      model: process.env["DEEPSEEK_MODEL"],
    });
  },
};
