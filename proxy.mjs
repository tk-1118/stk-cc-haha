import http from "node:http";

// ─── Config ──────────────────────────────────────────────────────────────────
const UPSTREAM_HOST = "62.234.66.78";
const UPSTREAM_PORT = 3000;
const LISTEN_PORT = 4000;
const DEBUG = process.env.PROXY_DEBUG === "1";

// ─── Anthropic → OpenAI request conversion ──────────────────────────────────

function convertAnthropicToOpenAI(body) {
  const messages = [];

  if (body.system) {
    const systemText =
      typeof body.system === "string"
        ? body.system
        : body.system.map((b) => b.text ?? "").join("\n");
    messages.push({ role: "system", content: systemText });
  }

  for (const msg of body.messages ?? []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      messages.push({ role: msg.role, content: String(msg.content ?? "") });
      continue;
    }

    if (msg.role === "assistant") {
      const textParts = [];
      const toolCalls = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments:
                typeof block.input === "string"
                  ? block.input
                  : JSON.stringify(block.input),
            },
          });
        }
      }
      const m = { role: "assistant", content: textParts.join("") || null };
      if (toolCalls.length > 0) m.tool_calls = toolCalls;
      messages.push(m);
    } else {
      // user role: may contain text + tool_result blocks mixed
      const textParts = [];
      const toolResults = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "image") {
          textParts.push("[image]");
        } else if (block.type === "tool_result") {
          let resultContent = "";
          if (typeof block.content === "string") {
            resultContent = block.content;
          } else if (Array.isArray(block.content)) {
            resultContent = block.content
              .map((c) => c.text ?? JSON.stringify(c))
              .join("\n");
          }
          toolResults.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: resultContent,
          });
        }
      }
      if (textParts.length > 0) {
        messages.push({ role: "user", content: textParts.join("\n") });
      }
      for (const tr of toolResults) messages.push(tr);
    }
  }

  const req = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens ?? 4096,
    stream: body.stream ?? false,
    thinking: { type: "disabled" },
  };

  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  if (body.stop_sequences) req.stop = body.stop_sequences;

  if (body.tools && body.tools.length > 0) {
    req.tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }

  if (body.tool_choice) {
    if (body.tool_choice.type === "any") {
      req.tool_choice = "required";
    } else if (body.tool_choice.type === "auto") {
      req.tool_choice = "auto";
    } else if (body.tool_choice.type === "tool" && body.tool_choice.name) {
      req.tool_choice = {
        type: "function",
        function: { name: body.tool_choice.name },
      };
    }
  }

  return req;
}

// ─── OpenAI → Anthropic response conversion (non-streaming) ────────────────

function convertOpenAIToAnthropic(oaiResp, model) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: oaiResp.id ?? "msg_error",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model: model,
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const content = [];
  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input;
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = { raw: tc.function.arguments };
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  const stopMap = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "end_turn",
  };

  return {
    id: oaiResp.id ?? `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model: oaiResp.model ?? model,
    stop_reason: stopMap[choice.finish_reason] ?? "end_turn",
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens ?? 0,
      output_tokens: oaiResp.usage?.completion_tokens ?? 0,
    },
  };
}

// ─── OpenAI SSE → Anthropic SSE streaming conversion ────────────────────────

function createStreamTransformer(model, clientRes) {
  let msgId = `msg_${Date.now()}`;
  let sentStart = false;
  let blockIndex = 0;
  let currentBlockType = null; // "text" | "tool_use"
  let toolCallBuffers = {};    // id → {name, arguments}
  let inputTokens = 0;
  let outputTokens = 0;

  function send(event, data) {
    clientRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function ensureMessageStart() {
    if (sentStart) return;
    sentStart = true;
    send("message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    });
  }

  function startTextBlock() {
    ensureMessageStart();
    send("content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "" },
    });
    currentBlockType = "text";
  }

  function stopCurrentBlock() {
    if (currentBlockType != null) {
      send("content_block_stop", {
        type: "content_block_stop",
        index: blockIndex,
      });
      blockIndex++;
      currentBlockType = null;
    }
  }

  return {
    processChunk(oaiChunk) {
      if (oaiChunk.usage) {
        inputTokens = oaiChunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = oaiChunk.usage.completion_tokens ?? outputTokens;
      }

      const choice = oaiChunk.choices?.[0];
      if (!choice) return;

      const delta = choice.delta ?? {};
      if (oaiChunk.id) msgId = oaiChunk.id;

      // Text content delta
      if (delta.content) {
        if (currentBlockType !== "text") {
          stopCurrentBlock();
          startTextBlock();
        }
        send("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      // Tool calls delta
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (tc.id) {
            // new tool call starting
            stopCurrentBlock();
            ensureMessageStart();
            toolCallBuffers[idx] = {
              id: tc.id,
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            };
            send("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: {
                type: "tool_use",
                id: tc.id,
                name: tc.function?.name ?? "",
              },
            });
            currentBlockType = "tool_use";
          } else if (tc.function?.arguments) {
            if (toolCallBuffers[idx]) {
              toolCallBuffers[idx].arguments += tc.function.arguments;
            }
            send("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: {
                type: "input_json_delta",
                partial_json: tc.function.arguments,
              },
            });
          }
        }
      }

      // Finish
      if (choice.finish_reason) {
        stopCurrentBlock();
        const stopMap = {
          stop: "end_turn",
          length: "max_tokens",
          tool_calls: "tool_use",
        };
        send("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: stopMap[choice.finish_reason] ?? "end_turn",
          },
          usage: { output_tokens: outputTokens },
        });
        send("message_stop", { type: "message_stop" });
      }
    },

    ensureStarted() {
      ensureMessageStart();
    },

    finish() {
      if (!sentStart) {
        ensureMessageStart();
        startTextBlock();
        stopCurrentBlock();
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: outputTokens },
        });
        send("message_stop", { type: "message_stop" });
      }
    },
  };
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const server = http.createServer((clientReq, clientRes) => {
  // Health check
  if (clientReq.method === "GET" && clientReq.url === "/health") {
    clientRes.writeHead(200, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Only handle POST /v1/messages
  if (
    clientReq.method !== "POST" ||
    !clientReq.url?.startsWith("/v1/messages")
  ) {
    clientRes.writeHead(404, { "Content-Type": "application/json" });
    clientRes.end(
      JSON.stringify({ error: { message: `Not found: ${clientReq.url}` } })
    );
    return;
  }

  const chunks = [];
  clientReq.on("data", (c) => chunks.push(c));
  clientReq.on("end", () => {
    let anthropicBody;
    try {
      anthropicBody = JSON.parse(Buffer.concat(chunks).toString());
    } catch (e) {
      clientRes.writeHead(400, { "Content-Type": "application/json" });
      clientRes.end(
        JSON.stringify({ error: { message: "Invalid JSON body" } })
      );
      return;
    }

    const isStream = anthropicBody.stream === true;
    const model = anthropicBody.model ?? "glm-5.1";

    let openaiBody;
    try {
      openaiBody = convertAnthropicToOpenAI(anthropicBody);
    } catch (e) {
      clientRes.writeHead(500, { "Content-Type": "application/json" });
      clientRes.end(
        JSON.stringify({
          error: { message: `Conversion error: ${e.message}` },
        })
      );
      return;
    }

    if (isStream) openaiBody.stream = true;

    const payload = JSON.stringify(openaiBody);
    if (DEBUG) {
      console.log("[proxy] →", clientReq.url);
      console.log("[proxy] anthropic body:", JSON.stringify(anthropicBody).slice(0, 500));
      console.log("[proxy] openai body:", payload.slice(0, 500));
    }

    const apiKey =
      clientReq.headers["x-api-key"] ??
      clientReq.headers["authorization"]?.replace("Bearer ", "") ??
      "";

    const proxyReq = http.request(
      {
        hostname: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (proxyRes) => {
        if (proxyRes.statusCode !== 200) {
          const errChunks = [];
          proxyRes.on("data", (c) => errChunks.push(c));
          proxyRes.on("end", () => {
            const errBody = Buffer.concat(errChunks).toString();
            console.error("[proxy] upstream error:", proxyRes.statusCode, errBody);
            clientRes.writeHead(proxyRes.statusCode, {
              "Content-Type": "application/json",
            });
            clientRes.end(
              JSON.stringify({
                type: "error",
                error: {
                  type: "api_error",
                  message: `Upstream ${proxyRes.statusCode}: ${errBody}`,
                },
              })
            );
          });
          return;
        }

        if (!isStream) {
          // Non-streaming: collect full response and convert
          const respChunks = [];
          proxyRes.on("data", (c) => respChunks.push(c));
          proxyRes.on("end", () => {
            try {
              const oaiResp = JSON.parse(
                Buffer.concat(respChunks).toString()
              );
              const anthropicResp = convertOpenAIToAnthropic(oaiResp, model);
              if (DEBUG) console.log("[proxy] ← anthropic:", JSON.stringify(anthropicResp).slice(0, 500));
              clientRes.writeHead(200, {
                "Content-Type": "application/json",
              });
              clientRes.end(JSON.stringify(anthropicResp));
            } catch (e) {
              console.error("[proxy] response parse error:", e.message);
              clientRes.writeHead(500, {
                "Content-Type": "application/json",
              });
              clientRes.end(
                JSON.stringify({
                  error: { message: `Response parse error: ${e.message}` },
                })
              );
            }
          });
        } else {
          // Streaming: convert SSE events on the fly
          clientRes.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          const transformer = createStreamTransformer(model, clientRes);
          let buffer = "";

          proxyRes.on("data", (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(":")) continue;
              if (trimmed === "data: [DONE]") {
                transformer.finish();
                clientRes.end();
                return;
              }
              if (trimmed.startsWith("data: ")) {
                try {
                  const oaiChunk = JSON.parse(trimmed.slice(6));
                  transformer.processChunk(oaiChunk);
                } catch (e) {
                  if (DEBUG) console.error("[proxy] chunk parse error:", e.message, trimmed);
                }
              }
            }
          });

          proxyRes.on("end", () => {
            if (buffer.trim() === "data: [DONE]") {
              transformer.finish();
            }
            clientRes.end();
          });
        }
      }
    );

    proxyReq.on("error", (err) => {
      console.error("[proxy] request error:", err.message);
      clientRes.writeHead(502, { "Content-Type": "application/json" });
      clientRes.end(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: `Upstream: ${err.message}` },
        })
      );
    });

    proxyReq.write(payload);
    proxyReq.end();
  });
});

server.listen(LISTEN_PORT, () => {
  console.log(
    `[proxy] Anthropic→OpenAI proxy on :${LISTEN_PORT} → ${UPSTREAM_HOST}:${UPSTREAM_PORT}`
  );
  console.log(`[proxy] thinking: disabled | debug: ${DEBUG}`);
  console.log(`[proxy] Use PROXY_DEBUG=1 to enable request/response logging`);
});
