import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, TOOL_SPECS } from "./prompt";

export type ProviderId = "anthropic" | "gemini";

export interface ModelOption { id: string; label: string }

export const PROVIDERS: Record<ProviderId, { label: string; keyUrl: string; keyHint: string; models: ModelOption[] }> = {
  anthropic: {
    label: "Anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
    models: [
      { id: "claude-opus-5", label: "Claude Opus 5" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ],
  },
  gemini: {
    label: "Google Gemini",
    keyUrl: "https://aistudio.google.com/apikey",
    keyHint: "AIza…",
    models: [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    ],
  },
};

export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface Turn { text: string[]; calls: ToolCall[] }
export interface ToolReply { id: string; name: string; result: string }

/** One conversation with one provider. `step` sends the pending tool replies and returns the model's next turn. */
export interface Session {
  step(replies: ToolReply[], signal: AbortSignal): Promise<Turn>;
}

export function openSession(provider: ProviderId, apiKey: string, model: string, task: string): Session {
  return provider === "anthropic" ? anthropicSession(apiKey, model, task) : geminiSession(apiKey, model, task);
}

function anthropicSession(apiKey: string, model: string, task: string): Session {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const tools: Anthropic.Tool[] = TOOL_SPECS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: { type: "object", properties: t.properties, required: t.required, additionalProperties: false },
    strict: true,
  }));
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  let pending: Anthropic.ToolUseBlock[] = [];

  return {
    async step(replies, signal) {
      if (replies.length) {
        messages.push({
          role: "user",
          content: replies.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.result })),
        });
      }
      pending = [];
      const stream = client.messages.stream(
        {
          model,
          max_tokens: 32_000,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools,
          messages,
        },
        { signal },
      );
      const msg = await stream.finalMessage();
      if (msg.stop_reason === "refusal") throw new Error("The model declined this request.");
      messages.push({ role: "assistant", content: msg.content });
      const text: string[] = [];
      for (const b of msg.content) {
        if (b.type === "text" && b.text.trim()) text.push(b.text.trim());
        if (b.type === "tool_use") pending.push(b);
      }
      return { text, calls: pending.map((b) => ({ id: b.id, name: b.name, args: b.input as Record<string, unknown> })) };
    },
  };
}

function geminiSession(apiKey: string, model: string, task: string): Session {
  const contents: unknown[] = [{ role: "user", parts: [{ text: task }] }];
  const tools = [
    {
      functionDeclarations: TOOL_SPECS.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: "OBJECT",
          properties: Object.fromEntries(
            Object.entries(t.properties).map(([k, v]) => [k, { type: "STRING", description: v.description }]),
          ),
          required: t.required,
        },
      })),
    },
  ];
  let counter = 0;

  return {
    async step(replies, signal) {
      if (replies.length) {
        contents.push({
          role: "user",
          parts: replies.map((r) => ({ functionResponse: { name: r.name, response: { content: r.result } } })),
        });
      }
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents,
            tools,
            toolConfig: { functionCallingConfig: { mode: "ANY" } },
            generationConfig: { temperature: 0.2 },
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const msg = body.match(/"message":\s*"([^"]+)"/)?.[1] ?? res.statusText;
        throw new Error(`Gemini ${res.status}: ${msg}`);
      }
      const data = await res.json();
      const parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }> =
        data?.candidates?.[0]?.content?.parts ?? [];
      if (!parts.length) throw new Error("Gemini returned an empty turn. Try again.");
      contents.push({ role: "model", parts });
      const text: string[] = [];
      const calls: ToolCall[] = [];
      for (const p of parts) {
        if (p.text?.trim()) text.push(p.text.trim());
        if (p.functionCall) calls.push({ id: `g${++counter}`, name: p.functionCall.name, args: p.functionCall.args ?? {} });
      }
      return { text, calls };
    },
  };
}
