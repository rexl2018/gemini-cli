/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CountTokensResponse,
  GenerateContentResponse,
  GenerateContentParameters,
  CountTokensParameters,
  EmbedContentResponse,
  EmbedContentParameters,
  Content,
  Part,
  ContentListUnion,
  FunctionCall,
} from '@google/genai';
import { FinishReason } from '@google/genai';
import type { ContentGenerator } from './contentGenerator.js';
import { debugLogger } from '../utils/debugLogger.js';
import axios, { type AxiosInstance } from 'axios';

interface OpenAIChoiceDelta {
  content?: string;
  function_call?: { name?: string; arguments?: string };
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAIChoiceMessage {
  content?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments: string };
  }>;
}

interface OpenAIChoice {
  message?: OpenAIChoiceMessage;
  finish_reason?: string | null;
  delta?: OpenAIChoiceDelta;
}

interface OpenAIResponseLike {
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface OpenAICandidate {
  content: {
    role: string;
    parts: Part[];
  };
  index: number;
  finishReason?: FinishReason;
}

class OpenAIGenerateContentResponse implements GenerateContentResponse {
  candidates: OpenAICandidate[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  modelVersion?: string;
  responseId?: string;

  constructor(
    candidates: OpenAICandidate[],
    usage?: {
      promptTokenCount: number;
      candidatesTokenCount: number;
      totalTokenCount: number;
    },
  ) {
    this.candidates = candidates;
    this.usageMetadata = usage;
  }

  get text(): string {
    const parts = this.candidates?.[0]?.content?.parts ?? [];
    return parts
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('');
  }

  get functionCalls(): FunctionCall[] | undefined {
    const parts = this.candidates?.[0]?.content?.parts;
    if (!parts) return undefined;
    const fcs = parts
      .filter(
        (part: unknown) => !!(part as { functionCall?: unknown }).functionCall,
      )
      .map(
        (part: unknown) =>
          (part as { functionCall: FunctionCall }).functionCall,
      );
    return fcs.length > 0 ? fcs : undefined;
  }

  get data(): string {
    return '';
  }
  get executableCode(): string {
    return '';
  }
  get codeExecutionResult(): string {
    return '';
  }
}

export interface OpenAIConfig {
  endpoint?: string;
  model: string;
  apiKey?: string;
  endpoint_postfix?: string; // not used for standard OpenAI
}

export class OpenAICompatibleContentGenerator implements ContentGenerator {
  private axios: AxiosInstance;

  constructor(private config: OpenAIConfig) {
    // 构建完整的 baseURL，包含 endpoint_postfix
    let baseURL = this.config.endpoint || '';
    if (this.config.endpoint_postfix) {
      // 确保 endpoint 和 postfix 之间正确连接
      const endpoint = this.config.endpoint?.endsWith('/')
        ? this.config.endpoint.slice(0, -1)
        : this.config.endpoint;
      const postfix = this.config.endpoint_postfix.startsWith('/')
        ? this.config.endpoint_postfix
        : '/' + this.config.endpoint_postfix;
      baseURL = endpoint + postfix;
    }

    this.axios = axios.create({
      baseURL,
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey && {
          Authorization: `Bearer ${this.config.apiKey}`,
        }),
      },
      timeout: 60000, // 60秒超时
    });
  }

  private stringifyForLog(obj: unknown, max: number = 1200): string {
    try {
      const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
      if (!s) return '';
      return s.length > max ? s.slice(0, max) + '…(truncated)' : s;
    } catch {
      return '[unserializable]';
    }
  }

  // NEW: Build a sanitized cURL command for reproducing requests (Authorization redacted)
  private buildCurlCommand(
    url: string,
    headersObj: unknown,
    bodyObj: unknown,
  ): string {
    const headers: Record<string, string> = {};
    try {
      const h = headersObj as Record<string, unknown>;
      // Flatten common axios headers structure
      const maybeCommon = (h?.['common'] ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(maybeCommon)) {
        if (typeof v === 'string') headers[k] = v;
      }
      for (const [k, v] of Object.entries(h || {})) {
        if (typeof v === 'string') headers[k] = v;
      }
    } catch {
      // ignore
    }
    // Redact Authorization
    if (headers['Authorization'])
      headers['Authorization'] = 'Bearer <REDACTED>';
    // Build header flags lines (each on its own line with shell continuation)
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `  -H '${k}: ${v}' \\\n`)
      .join('');

    // Pretty-print JSON body
    let body = '';
    try {
      body = JSON.stringify(bodyObj ?? {}, null, 2);
    } catch {
      body = '{}';
    }

    // Emit heredoc-based cURL so users can copy-paste safely even with single quotes inside JSON
    const cmd = `curl -X POST '${url}' \\\n${headerLines}  --data-binary @- <<'JSON'\n${body}\nJSON`;
    return cmd;
  }

  // 将 Node 可读流读取为字符串，避免循环结构导致的 JSON 序列化错误
  private async readStreamToString(stream: unknown): Promise<string> {
    try {
      const readable = stream as {
        setEncoding?: (enc: string) => void;
        on: (event: string, cb: (...args: unknown[]) => void) => void;
      };
      return await new Promise<string>((resolve, reject) => {
        let buffer = '';
        try {
          readable.setEncoding?.('utf8');
        } catch {
          // ignore
        }
        readable.on('data', (chunk: unknown) => {
          buffer += typeof chunk === 'string' ? chunk : String(chunk);
        });
        readable.on('end', () => resolve(buffer));
        readable.on('error', (err: unknown) => reject(err));
      });
    } catch {
      return '[unserializable]';
    }
  }

  private async *parseSSEStream(
    stream: AsyncIterable<Buffer>,
  ): AsyncGenerator<unknown> {
    let buffer = '';

    for await (const chunk of stream) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留最后一行（可能不完整）

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            return;
          }
          try {
            const parsed = JSON.parse(data);
            yield parsed;
          } catch {
            // 忽略无法解析的行
          }
        }
      }
    }
  }

  private convertToolsToOpenAIFormat(tools: unknown):
    | Array<{
        type: 'function';
        function: { name?: string; description?: string; parameters: unknown };
      }>
    | undefined {
    if (!tools || !Array.isArray(tools)) return undefined;
    const openAITools: Array<{
      type: 'function';
      function: { name?: string; description?: string; parameters: unknown };
    }> = [];
    for (const group of tools) {
      const fns = group?.functionDeclarations;
      if (Array.isArray(fns)) {
        for (const fn of fns) {
          openAITools.push({
            type: 'function',
            function: {
              name: fn.name,
              description: fn.description,
              parameters: fn.parametersJsonSchema || {},
            },
          });
        }
      }
    }
    return openAITools.length > 0 ? openAITools : undefined;
  }

  // NEW: convert tools into Responses API format (flat shape)
  private convertToolsToResponsesFormat(tools: unknown):
    | Array<{
        type: 'function';
        name?: string;
        description?: string;
        parameters?: unknown;
      }>
    | undefined {
    if (!tools || !Array.isArray(tools)) return undefined;
    const respTools: Array<{
      type: 'function';
      name?: string;
      description?: string;
      parameters?: unknown;
    }> = [];
    for (const group of tools) {
      const fns = group?.functionDeclarations;
      if (Array.isArray(fns)) {
        for (const fn of fns) {
          respTools.push({
            type: 'function',
            name: fn.name,
            description: fn.description,
            parameters: fn.parametersJsonSchema || { type: 'object' },
          });
        }
      }
    }
    return respTools.length > 0 ? respTools : undefined;
  }

  // removed prepareResponsesInput - superseded by buildResponsesInputFromMessages

  // NEW: build Responses API input array like the validated curl: include system, user text, assistant tool_calls, and tool results
  private buildResponsesInputFromMessages(
    messages: Array<
      | {
          role: 'system' | 'user' | 'assistant' | 'developer';
          content: string;
          tool_calls?: Array<{
            id: string;
            type: 'function';
            function: { name?: string; arguments: string };
          }>;
        }
      | { role: 'tool'; tool_call_id: string; content: string }
    >,
  ): Array<
    | {
        role: 'assistant' | 'system' | 'user' | 'developer';
        content: Array<{ type: string; text: string }>;
      }
    | {
        type: 'function_call';
        call_id?: string;
        name?: string;
        arguments?: string;
      }
    | { type: 'function_call_output'; call_id: string; output: string }
  > {
    const input: Array<
      | {
          role: 'assistant' | 'system' | 'user' | 'developer';
          content: Array<{ type: string; text: string }>;
        }
      | {
          type: 'function_call';
          call_id?: string;
          name?: string;
          arguments?: string;
        }
      | { type: 'function_call_output'; call_id: string; output: string }
    > = [];

    for (const m of messages || []) {
      const role = (m as { role?: string }).role as
        | 'system'
        | 'user'
        | 'assistant'
        | 'developer'
        | 'tool'
        | undefined;
      const text = (m as { content?: string }).content || '';

      if (
        role === 'assistant' ||
        role === 'system' ||
        role === 'user' ||
        role === 'developer'
      ) {
        // Map text content according to provider constraints
        if (typeof text === 'string' && text.trim().length > 0) {
          const contentType =
            role === 'assistant' ? 'output_text' : 'input_text';
          input.push({
            role,
            content: [{ type: contentType, text: text.trim() }],
          });
        }
        // Emit function_call entries as separate items (not inside content), if present
        const tcs =
          (
            m as {
              tool_calls?: Array<{
                id: string;
                function: { name?: string; arguments: string };
              }>;
            }
          ).tool_calls || [];
        for (const tc of tcs) {
          input.push({
            type: 'function_call',
            call_id: tc.id || undefined,
            name: tc.function?.name,
            arguments: tc.function?.arguments,
          });
        }
        continue;
      }

      if (role === 'tool') {
        // Convert tool result to function_call_output with call_id and output
        const toolMsg = m as {
          role: 'tool';
          tool_call_id: string;
          content: string;
        };
        const outputStr =
          typeof toolMsg.content === 'string'
            ? toolMsg.content
            : JSON.stringify(toolMsg.content);
        if (toolMsg.tool_call_id) {
          input.push({
            type: 'function_call_output',
            call_id: toolMsg.tool_call_id,
            output: outputStr,
          });
        }
        continue;
      }
    }

    // Fallback: ensure non-empty input (minimal user input)
    if (input.length === 0) {
      input.push({ role: 'user', content: [{ type: 'input_text', text: '' }] });
    }

    return input;
  }

  private toMessages(contents: ContentListUnion): Array<
    | {
        role: 'system' | 'user' | 'assistant';
        content: string;
        tool_calls?: Array<{
          id: string;
          type: 'function';
          function: { name?: string; arguments: string };
        }>;
      }
    | { role: 'tool'; tool_call_id: string; content: string }
  > {
    // string -> single user message
    if (typeof contents === 'string')
      return [{ role: 'user', content: contents }];

    // Part[] (no role) -> system
    if (Array.isArray(contents)) {
      const arr = contents as unknown[];
      const looksLikePartArray =
        arr.length > 0 &&
        arr.every(
          (p) =>
            typeof p === 'object' &&
            p !== null &&
            !('role' in (p as Record<string, unknown>)),
        );
      if (looksLikePartArray) {
        const text = arr
          .filter((p) => typeof (p as { text?: unknown }).text === 'string')
          .map((p) => (p as { text?: string }).text as string)
          .join('\n');
        return text ? [{ role: 'system', content: text }] : [];
      }
    }

    // Content or Content[]
    const list: Content[] = Array.isArray(contents)
      ? (contents as Content[])
      : [contents as Content];
    type ToolCall = {
      id: string;
      type: 'function';
      function: { name?: string; arguments: string };
    };
    type OpenAIMessage = {
      role: 'system' | 'user' | 'assistant';
      content: string;
      tool_calls?: ToolCall[];
    };
    type OpenAIToolMessage = {
      role: 'tool';
      tool_call_id: string;
      content: string;
    };
    const out: Array<OpenAIMessage | OpenAIToolMessage> = [];
    const pendingToolCallIds = new Map<string, string[]>();
    const allToolCallIds = new Set<string>();
    const usedToolCallIds = new Set<string>();
    const genToolCallId = (name?: string) =>
      `${name || 'tool'}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    for (const c of list) {
      const role =
        c.role === 'model'
          ? 'assistant'
          : ((c.role === 'system' ? 'system' : 'user') as
              | 'system'
              | 'user'
              | 'assistant');
      const parts = c.parts || [];

      const text = parts
        .filter(
          (p: unknown) => typeof (p as { text?: unknown }).text === 'string',
        )
        .map((p: unknown) => (p as { text: string }).text)
        .filter(Boolean)
        .join('\n\n');

      const tool_calls: ToolCall[] = parts
        .filter(
          (p: unknown) =>
            (p as { functionCall?: unknown }).functionCall !== undefined,
        )
        .map((p: unknown) => {
          const fc = (
            p as {
              functionCall?: {
                name?: string;
                id?: string;
                args?: Record<string, unknown>;
              };
            }
          ).functionCall!;
          const name = fc.name;
          const id = fc.id || genToolCallId(name);
          if (name && id) {
            const queue = pendingToolCallIds.get(name) || [];
            queue.push(id);
            pendingToolCallIds.set(name, queue);
          }
          allToolCallIds.add(id);
          return {
            id,
            type: 'function',
            function: {
              name,
              arguments: JSON.stringify(fc.args || {}),
            },
          };
        });

      const hasFunctionResponse = (parts as unknown[]).some(
        (p) =>
          (p as { functionResponse?: unknown }).functionResponse !== undefined,
      );

      if (role === 'assistant') {
        const message: OpenAIMessage = {
          role: 'assistant',
          content: text || '',
        };
        if (tool_calls.length > 0) {
          message.tool_calls = tool_calls;
        }
        if (message.content || message.tool_calls) {
          out.push(message);
        }
      } else {
        // For non-assistant roles:
        // If this Content includes functionResponse parts, defer emitting its text
        // and instead embed it into the subsequent tool result messages (extra_text).
        // Otherwise (pure text content), emit it immediately.
        if (text && text.trim() && !hasFunctionResponse) {
          out.push({ role: role as 'system' | 'user', content: text });
        }
      }

      for (const p of parts as unknown[]) {
        const frAny = (p as { functionResponse?: unknown }).functionResponse;
        if (frAny && typeof frAny === 'object') {
          const fr = frAny as {
            name?: string;
            id?: string;
            response?: unknown;
          };
          const resp = fr.response as unknown;
          let payload = '';
          if (typeof resp === 'string') payload = resp;
          else if (
            resp &&
            typeof (resp as { llmContent?: unknown }).llmContent === 'string'
          )
            payload = (resp as { llmContent: string }).llmContent;
          else if (
            resp &&
            typeof (resp as { output?: unknown }).output === 'string'
          )
            payload = (resp as { output: string }).output;
          else if (
            resp &&
            typeof (resp as { result?: unknown }).result === 'string'
          )
            payload = (resp as { result: string }).result;
          else if (
            resp &&
            typeof (resp as { error?: unknown }).error === 'string'
          )
            payload = (resp as { error: string }).error;
          else {
            try {
              payload = JSON.stringify(resp ?? fr);
            } catch {
              payload = '[functionResponse]';
            }
          }
          // Only emit a tool result if we can match a prior tool_call id
          let toolCallId: string | undefined = fr.id;
          // Fallback: if id is missing OR id does not exist in recorded tool_calls, try matching by name queue
          if (!toolCallId || (toolCallId && !allToolCallIds.has(toolCallId))) {
            if (fr.name) {
              const queue = pendingToolCallIds.get(fr.name);
              if (queue && queue.length > 0) {
                toolCallId = queue.shift();
                pendingToolCallIds.set(fr.name, queue);
              }
            }
          }
          if (!toolCallId) {
            // Skip emitting unmatched tool result to avoid count mismatch
            continue;
          }
          usedToolCallIds.add(toolCallId);
          // Wrap tool response content into a structured JSON string to improve backend compatibility
          const toolContent = (() => {
            try {
              const parsed = JSON.parse(payload);
              return JSON.stringify({
                name: fr.name,
                result: parsed,
                ...(role !== 'assistant' && hasFunctionResponse && text
                  ? { extra_text: text }
                  : {}),
              });
            } catch {
              return JSON.stringify({
                name: fr.name,
                result: payload,
                ...(role !== 'assistant' && hasFunctionResponse && text
                  ? { extra_text: text }
                  : {}),
              });
            }
          })();
          out.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: toolContent,
          });
        }
      }

      // Do not emit additional non-assistant text here; when functionResponse exists,
      // it has been embedded into tool result as extra_text. For pure text messages,
      // we've already emitted above.
    }

    // Prune unmatched tool_calls to satisfy backend requirement: tool result counts must equal tool call counts
    if (allToolCallIds.size > usedToolCallIds.size) {
      const unmatchedIds = new Set<string>();
      for (const id of allToolCallIds) {
        if (!usedToolCallIds.has(id)) unmatchedIds.add(id);
      }
      if (unmatchedIds.size > 0) {
        for (let i = 0; i < out.length; i++) {
          const msg = out[i];
          if (msg && (msg as { role: string }).role === 'assistant') {
            const m = msg as OpenAIMessage;
            if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
              m.tool_calls = m.tool_calls.filter(
                (tc) => !unmatchedIds.has(tc.id),
              );
            }
          }
        }
      }
    }

    // NEW: Prune tool messages whose tool_call_id does not match any assistant tool_call id
    // This prevents sending extra tool results when the prior tool_calls are not present in the message history
    if (out.length > 0) {
      for (let i = out.length - 1; i >= 0; i--) {
        const msg = out[i] as OpenAIToolMessage | OpenAIMessage;
        if (msg && (msg as { role: string }).role === 'tool') {
          const toolMsg = msg as OpenAIToolMessage;
          if (
            !toolMsg.tool_call_id ||
            !allToolCallIds.has(toolMsg.tool_call_id)
          ) {
            // Remove unmatched tool result to satisfy backend constraint
            out.splice(i, 1);
          }
        }
      }
    }

    return out;
  }

  // NEW: helper to summarize tool_call and tool result counts for debugging
  private getToolCounts(messages: Array<OpenAIMessage | OpenAIToolMessage>): {
    calls: number;
    results: number;
    missingResults: number; // assistant tool_calls without matching tool result
    orphanResults: number; // tool results without matching assistant tool_call
    missingIds: string[]; // IDs of assistant tool_calls without matching result
    orphanIds: string[]; // IDs of tool results without matching call
  } {
    let calls = 0;
    let results = 0;
    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of messages || []) {
      const role = (m as { role?: string }).role;
      if (
        role === 'assistant' &&
        Array.isArray((m as OpenAIMessage).tool_calls)
      ) {
        for (const tc of (m as OpenAIMessage).tool_calls!) {
          calls++;
          const id = (tc as OpenAIToolCall)?.id;
          if (typeof id === 'string' && id) callIds.add(id);
        }
      } else if (role === 'tool') {
        results++;
        const tid = (m as OpenAIToolMessage).tool_call_id;
        if (typeof tid === 'string' && tid) resultIds.add(tid);
      }
    }
    const missingIds: string[] = [];
    for (const id of callIds) {
      if (!resultIds.has(id)) missingIds.push(id);
    }
    const orphanIds: string[] = [];
    for (const id of resultIds) {
      if (!callIds.has(id)) orphanIds.push(id);
    }
    return {
      calls,
      results,
      missingResults: missingIds.length,
      orphanResults: orphanIds.length,
      missingIds,
      orphanIds,
    };
  }

  // NEW: env-based switch for Responses API vs Chat/Completions
  private shouldUseResponsesApi(): boolean {
    const v = process.env['LLM_BYOK_RESPONSE_API'];
    return !!v && v !== '0';
  }

  // NEW: pick proper URL according to env and known path patterns
  private getTargetURL(useResponses: boolean): string {
    const base = String(this.axios.defaults.baseURL || '');
    if (!base) return '';
    let url = base;
    if (useResponses) {
      url = url.includes('/v2/crawl')
        ? url.replace(/\/v2\/crawl\/?/, '/responses')
        : url;
    } else {
      // chat/completions
      url = url.includes('/responses')
        ? url.replace(/\/responses\/?/, '/v2/crawl')
        : url;
    }
    // Normalize any accidental slash before query string, e.g. '/responses/?ak=...'
    url = url
      .replace('/responses/?', '/responses?')
      .replace('/v2/crawl/?', '/v2/crawl?');
    return url;
  }

  // Helper: check if Responses API payload includes any tool_call entries
  private hasResponsesToolCalls(resData: unknown): boolean {
    try {
      const data = resData as Record<string, unknown>;
      const output = (data?.['output'] ?? []) as Array<Record<string, unknown>>;
      for (const item of output) {
        const type = String(item['type'] ?? '');
        if (type === 'tool_call' || type === 'function_call') return true;
        if (type === 'message') {
          const contentArr = (item['content'] ?? []) as Array<
            Record<string, unknown>
          >;
          if (
            Array.isArray(contentArr) &&
            contentArr.some((c) => {
              const ctype = String(c['type'] ?? '');
              return ctype === 'tool_call' || ctype === 'function_call';
            })
          ) {
            return true;
          }
        }
      }
    } catch {
      // ignore
    }
    return false;
  }

  private logRequestDebug(request: GenerateContentParameters) {
    const contentsArray: Content[] = (() => {
      const c = request.contents as unknown;
      if (typeof c === 'string')
        return [{ role: 'user', parts: [{ text: c }] } as Content];
      if (Array.isArray(c)) {
        const looksLikePartArray =
          c.length > 0 &&
          c.every(
            (p: unknown) =>
              typeof p === 'object' &&
              p !== null &&
              !('role' in (p as Record<string, unknown>)),
          );
        if (looksLikePartArray)
          return [{ role: 'system', parts: c } as Content];
        return c as Content[];
      }
      return [c as Content];
    })();

    const truncate = (s: string, max = 120) =>
      s.length > max ? s.slice(0, max) + '...' : s;
    debugLogger.log(
      `[OpenAIComp] Conversation (${contentsArray.length} messages)`,
    );
    contentsArray.forEach((content, i) => {
      const role =
        content.role === 'model' ? 'assistant' : content.role || 'user';
      debugLogger.log(`[OpenAIComp]   [${i}] Role: ${role}`);
      (content.parts || []).forEach((p: unknown, idx: number) => {
        const textVal = (p as { text?: unknown }).text;
        if (typeof textVal === 'string') {
          debugLogger.log(`[OpenAIComp]     Part[${idx}] ${truncate(textVal)}`);
        }
      });
    });
  }

  private convertFromOpenAIResponse(
    res: OpenAIResponseLike,
  ): GenerateContentResponse {
    const choice = res.choices?.[0];
    const content = (choice?.message?.content ?? '') || '';
    const parts: Part[] = [];
    if (content) parts.push({ text: content });
    const toolCalls = choice?.message?.tool_calls ?? [];
    for (const tc of toolCalls) {
      const name = tc.function?.name || 'tool';
      let args: Record<string, unknown> = {};
      const argStr = tc.function?.arguments || '';
      try {
        if (argStr) args = JSON.parse(argStr);
      } catch {
        void 0;
      }
      parts.push({ functionCall: { name, args, id: tc.id } } as Part);
    }
    const candidates: OpenAICandidate[] = [
      {
        content: { role: 'model', parts },
        index: 0,
        finishReason: (() => {
          const fr = choice?.finish_reason;
          if (!fr) return undefined;
          if (fr === 'stop') return FinishReason.STOP;
          if (fr === 'length') return FinishReason.MAX_TOKENS;
          if (fr === 'tool_calls' || fr === 'function_call')
            return FinishReason.STOP;
          return FinishReason.OTHER;
        })(),
      },
    ];
    const usage = res.usage
      ? {
          promptTokenCount: res.usage.prompt_tokens ?? 0,
          candidatesTokenCount: res.usage.completion_tokens ?? 0,
          totalTokenCount: res.usage.total_tokens ?? 0,
        }
      : undefined;
    return new OpenAIGenerateContentResponse(candidates, usage);
  }

  // NEW: converter for Responses API generic shape
  private convertFromResponsesApi(resData: unknown): GenerateContentResponse {
    const data = resData as Record<string, unknown> | undefined;
    const output = (data?.['output'] ?? []) as Array<Record<string, unknown>>;
    const parts: Part[] = [];

    for (const item of output) {
      const type = String(item['type'] ?? '');
      if (type === 'output_text') {
        const text = String(item['text'] ?? '');
        if (text) parts.push({ text });
      } else if (type === 'message') {
        // Some providers wrap outputs in a 'message' with a 'content' array
        const contentArr = (item['content'] ?? []) as Array<
          Record<string, unknown>
        >;
        for (const c of contentArr) {
          const ctype = String(c['type'] ?? '');
          if (ctype === 'output_text') {
            const text = String(c['text'] ?? '');
            if (text) parts.push({ text });
          } else if (ctype === 'tool_call' || ctype === 'function_call') {
            const name = String(c['name'] ?? 'tool');
            const id = String(
              (c as Record<string, unknown>)['call_id'] ??
                (c as Record<string, unknown>)['id'] ??
                '',
            );
            let args: Record<string, unknown> = {};
            const rawArgs = (c as Record<string, unknown>)['arguments'];
            try {
              if (typeof rawArgs === 'string') args = JSON.parse(rawArgs);
              else if (typeof rawArgs === 'object' && rawArgs)
                args = rawArgs as Record<string, unknown>;
            } catch {
              // ignore parse error
            }
            parts.push({ functionCall: { name, args, id } } as Part);
          }
        }
      } else if (type === 'tool_call' || type === 'function_call') {
        const name = String(item['name'] ?? 'tool');
        const id = String(item['call_id'] ?? item['id'] ?? '');
        let args: Record<string, unknown> = {};
        const rawArgs = item['arguments'];
        try {
          if (typeof rawArgs === 'string') args = JSON.parse(rawArgs);
          else if (typeof rawArgs === 'object' && rawArgs)
            args = rawArgs as Record<string, unknown>;
        } catch {
          // ignore parse error
        }
        parts.push({ functionCall: { name, args, id } } as Part);
      }
    }

    // Debug: log parsed outputs including any tool calls
    try {
      const toolParts = parts.filter(
        (p) => !!(p as { functionCall?: unknown }).functionCall,
      );
      if (toolParts.length > 0) {
        debugLogger.log(
          `[OpenAICompRecv] (responses) tool_calls=${this.stringifyForLog(toolParts)}`,
        );
      } else {
        debugLogger.log('[OpenAICompRecv] (responses) tool_calls=0');
      }
    } catch {
      // ignore
    }

    const candidates: OpenAICandidate[] = [
      {
        content: { role: 'model', parts },
        index: 0,
        finishReason: FinishReason.STOP,
      },
    ];

    const usageRaw = data?.['usage'] as Record<string, unknown> | undefined;
    const usage = usageRaw
      ? {
          promptTokenCount: Number(usageRaw['input_token_count'] ?? 0),
          candidatesTokenCount: Number(usageRaw['output_token_count'] ?? 0),
          totalTokenCount: Number(
            usageRaw['total_token_count'] ??
              ((usageRaw['input_token_count'] as number) ?? 0) +
                ((usageRaw['output_token_count'] as number) ?? 0),
          ),
        }
      : undefined;

    const resp = new OpenAIGenerateContentResponse(candidates, usage);
    // attach response id if available
    if (typeof data?.['response_id'] === 'string')
      resp.responseId = String(data['response_id']);
    return resp;
  }

  async generateContent(
    req: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const messages = this.toMessages(req.contents);
    this.logRequestDebug(req);
    debugLogger.log(
      `[OpenAICompSend] messages: ${this.stringifyForLog(messages)}`,
    );

    if (req.config?.systemInstruction) {
      messages.unshift({
        role: 'system',
        content:
          typeof req.config.systemInstruction === 'string'
            ? req.config.systemInstruction
            : (req.config.systemInstruction as { text?: string }).text || '',
      });
    }

    const tools = this.convertToolsToOpenAIFormat(req.config?.tools);
    // Try to infer a preferred tool to help from the user message
    const preferToolName = (() => {
      try {
        const merged = (messages || [])
          .map((m) => (m as { content?: string }).content || '')
          .join('\n')
          .toLowerCase();
        if (merged.includes('read_file')) return 'read_file';
        return undefined;
      } catch {
        return undefined;
      }
    })();

    // Remove misplaced declarations in non-stream path: ensure no sawFinish/toolCallsBuffer here

    const useResponses = this.shouldUseResponsesApi();
    const url = this.getTargetURL(useResponses);
    debugLogger.log(
      `[OpenAIComp] Mode: Responses API=${useResponses}; Final URL=${url}`,
    );

    const requestBody = useResponses
      ? {
          model: this.config.model,
          input: this.buildResponsesInputFromMessages(
            messages as Array<
              | {
                  role: 'system' | 'user' | 'assistant';
                  content: string;
                  tool_calls?: Array<{
                    id: string;
                    type: 'function';
                    function: { name?: string; arguments: string };
                  }>;
                }
              | { role: 'tool'; tool_call_id: string; content: string }
            >,
          ),
          // Add explicit max_output_tokens for Responses API (stream single-response path)
          max_output_tokens: req.config?.maxOutputTokens ?? 8192,
          ...(this.convertToolsToResponsesFormat(req.config?.tools)
            ? { tools: this.convertToolsToResponsesFormat(req.config?.tools) }
            : {}),
          tool_choice: preferToolName
            ? { type: 'function', function: { name: preferToolName } }
            : 'required',
        }
      : {
          model: this.config.model,
          messages,
          temperature: req.config?.temperature,
          max_tokens: req.config?.maxOutputTokens,
          top_p: req.config?.topP,
          stream: false,
          ...(tools ? { tools } : {}),
          // Force a tool call when tools are available
          ...(tools && tools.length > 0
            ? {
                tool_choice: preferToolName
                  ? { type: 'function', function: { name: preferToolName } }
                  : 'required',
              }
            : {}),
        };

    // NEW: log tool_call/result counts for better error diagnostics
    const counts = this.getToolCounts(
      messages as Array<OpenAIMessage | OpenAIToolMessage>,
    );
    debugLogger.log(
      `[OpenAICompSend] tool_calls=${counts.calls}, tool_results=${counts.results}, missing_results=${counts.missingResults}, orphan_results=${counts.orphanResults}, missing_ids=${JSON.stringify(counts.missingIds)}, orphan_ids=${JSON.stringify(counts.orphanIds)}`,
    );
    // NEW: Always log the cURL, headers and body for reproducing requests (sanitized)
    try {
      const curl = this.buildCurlCommand(
        String(url || this.axios.defaults.baseURL || ''),
        this.axios.defaults.headers,
        requestBody,
      );
      debugLogger.log(`[OpenAI Debug] cURL: ${curl}`);
      debugLogger.log(
        `[OpenAI Debug] Request Body: ${this.stringifyForLog(requestBody)}`,
      );
      debugLogger.log(
        `[OpenAI Debug] Request Headers: ${this.stringifyForLog(this.axios.defaults.headers)}`,
      );
      const sentTools = useResponses
        ? this.convertToolsToResponsesFormat(req.config?.tools)
        : tools;
      if (Array.isArray(sentTools)) {
        const names = sentTools
          .map((t: unknown) =>
            useResponses
              ? (t as { name?: string }).name
              : (t as { function?: { name?: string } }).function?.name,
          )
          .filter((n) => typeof n === 'string' && n.length > 0);
        debugLogger.log(
          `[OpenAICompSend] Tools sent (${names.length}): ${JSON.stringify(names)}`,
        );
      }
    } catch {
      // ignore debug/log errors
    }

    try {
      const response = await this.axios.post(url, requestBody);
      debugLogger.log(
        `[OpenAICompRaw] response: ${this.stringifyForLog(response.data)}`,
      );
      // Fallback: if Responses API returned no tool_call entries while tool_choice forced, retry via chat/completions
      if (useResponses && !this.hasResponsesToolCalls(response.data)) {
        debugLogger.log(
          '[OpenAIComp] No tool_call in Responses result; falling back to chat/completions for tool calling',
        );
        const chatUrl = this.getTargetURL(false);
        const chatBody = {
          model: this.config.model,
          messages,
          temperature: req.config?.temperature,
          max_tokens: req.config?.maxOutputTokens,
          top_p: req.config?.topP,
          stream: false,
          ...(tools ? { tools } : {}),
          ...(tools && tools.length > 0
            ? {
                tool_choice: preferToolName
                  ? { type: 'function', function: { name: preferToolName } }
                  : 'required',
              }
            : {}),
        };
        const chatResp = await this.axios.post(chatUrl, chatBody);
        debugLogger.log(
          `[OpenAICompRaw] (fallback chat) response: ${this.stringifyForLog(chatResp.data)}`,
        );
        return this.convertFromOpenAIResponse(
          chatResp.data as OpenAIResponseLike,
        );
      }
      return useResponses
        ? this.convertFromResponsesApi(response.data)
        : this.convertFromOpenAIResponse(response.data as OpenAIResponseLike);
    } catch (error) {
      // 只在错误时打印详细调试信息
      const axiosError = error as {
        response?: { data?: unknown; status?: number };
        message?: string;
      };
      const status = axiosError.response?.status ?? 'unknown';
      let errorBody = '';
      const respData = axiosError.response?.data;
      if (typeof respData === 'string') {
        errorBody = respData;
      } else if (
        respData &&
        typeof (respData as { on?: unknown }).on === 'function'
      ) {
        errorBody = await this.readStreamToString(respData);
      } else {
        errorBody = this.stringifyForLog(respData || axiosError.message);
      }
      debugLogger.log(`[OpenAI Debug] Request failed with status ${status}`);
      debugLogger.log(
        `[OpenAI Debug] Request URL: ${url || this.axios.defaults.baseURL}`,
      );
      debugLogger.log(
        `[OpenAI Debug] Request Body: ${this.stringifyForLog(requestBody)}`,
      );
      debugLogger.log(
        `[OpenAI Debug] Request Headers: ${this.stringifyForLog(this.axios.defaults.headers)}`,
      );
      // NEW: include tool counts alongside error body
      debugLogger.log(
        `[OpenAI Debug] ToolCounts: calls=${counts.calls}, results=${counts.results}, missing_results=${counts.missingResults}, orphan_results=${counts.orphanResults}, missing_ids=${JSON.stringify(counts.missingIds)}, orphan_ids=${JSON.stringify(counts.orphanIds)}`,
      );
      // NEW: Log reproducible cURL when 400 occurs (sanitized)
      if (status === 400) {
        const curl = this.buildCurlCommand(
          String(url || this.axios.defaults.baseURL || ''),
          this.axios.defaults.headers,
          requestBody,
        );
        debugLogger.log(`[OpenAI Debug] cURL: ${curl}`);
      }
      debugLogger.log(`[OpenAI Debug] Error Response Body: ${errorBody}`);
      throw error;
    }
  }

  async generateContentStream(
    req: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    return this._generateContentStream(req);
  }

  private async *_generateContentStream(
    req: GenerateContentParameters,
  ): AsyncGenerator<GenerateContentResponse> {
    const messages = this.toMessages(req.contents);
    this.logRequestDebug(req);
    debugLogger.log(
      `[OpenAICompSend] messages(stream): ${this.stringifyForLog(messages)}`,
    );

    if (req.config?.systemInstruction) {
      messages.unshift({
        role: 'system',
        content:
          typeof req.config.systemInstruction === 'string'
            ? req.config.systemInstruction
            : (req.config.systemInstruction as { text?: string }).text || '',
      });
    }

    const tools = this.convertToolsToOpenAIFormat(req.config?.tools);
    const preferToolName = (() => {
      try {
        const merged = (messages || [])
          .map((m) => (m as { content?: string }).content || '')
          .join('\n')
          .toLowerCase();
        if (merged.includes('read_file')) return 'read_file';
        return undefined;
      } catch {
        return undefined;
      }
    })();

    let sawFinish = false;
    const toolCallsBuffer = new Map<
      number,
      { id?: string; name?: string; arguments: string }
    >();
    const useResponses = this.shouldUseResponsesApi();
    const url = this.getTargetURL(useResponses);
    debugLogger.log(
      `[OpenAIComp] Mode(stream): Responses API=${useResponses}; Final URL=${url}`,
    );

    // If Responses API is enabled, use single-response compatibility path
    if (useResponses) {
      const requestBody = {
        model: this.config.model,
        input: this.buildResponsesInputFromMessages(
          messages as Array<
            | {
                role: 'system' | 'user' | 'assistant';
                content: string;
                tool_calls?: Array<{
                  id: string;
                  type: 'function';
                  function: { name?: string; arguments: string };
                }>;
              }
            | { role: 'tool'; tool_call_id: string; content: string }
          >,
        ),
        // Add explicit max_output_tokens for Responses API (stream single-response path)
        max_output_tokens: req.config?.maxOutputTokens ?? 8192,
        ...(this.convertToolsToResponsesFormat(req.config?.tools)
          ? { tools: this.convertToolsToResponsesFormat(req.config?.tools) }
          : {}),
      };

      // NEW: Always log the cURL, headers and body for reproducing requests (sanitized)
      try {
        const curl = this.buildCurlCommand(
          String(url || this.axios.defaults.baseURL || ''),
          this.axios.defaults.headers,
          requestBody,
        );
        debugLogger.log(`[OpenAI Debug] cURL: ${curl}`);
        debugLogger.log(
          `[OpenAI Debug] Request Body: ${this.stringifyForLog(requestBody)}`,
        );
        debugLogger.log(
          `[OpenAI Debug] Request Headers: ${this.stringifyForLog(this.axios.defaults.headers)}`,
        );
      } catch {
        // ignore
      }

      try {
        const response = await this.axios.post(url, requestBody);
        // NEW: Log raw response body for streaming-responses single-response path
        debugLogger.log(
          `[OpenAICompRaw] (responses stream-single) response: ${this.stringifyForLog(response.data)}`,
        );
        const converted = this.convertFromResponsesApi(response.data);
        yield converted;
        return;
      } catch (error) {
        const axiosError = error as {
          response?: { data?: unknown; status?: number };
          message?: string;
        };
        const status = axiosError.response?.status ?? 'unknown';
        let errorBody = '';
        const respData = axiosError.response?.data;
        if (typeof respData === 'string') {
          errorBody = respData;
        } else if (
          respData &&
          typeof (respData as { on?: unknown }).on === 'function'
        ) {
          errorBody = await this.readStreamToString(respData);
        } else {
          errorBody = this.stringifyForLog(respData || axiosError.message);
        }
        debugLogger.log(
          `[OpenAI Debug] Responses stream-fallback request failed with status ${status}`,
        );
        debugLogger.log(`[OpenAI Debug] Request URL: ${url}`);
        debugLogger.log(
          `[OpenAI Debug] Request Body: ${this.stringifyForLog(requestBody)}`,
        );
        debugLogger.log(
          `[OpenAI Debug] Request Headers: ${this.stringifyForLog(this.axios.defaults.headers)}`,
        );
        debugLogger.log(`[OpenAI Debug] Error Response Body: ${errorBody}`);
        throw error;
      }
    }

    const requestBody = {
      model: this.config.model,
      messages,
      temperature: req.config?.temperature,
      max_tokens: req.config?.maxOutputTokens,
      top_p: req.config?.topP,
      stream: true,
      ...(tools ? { tools } : {}),
      ...(tools && tools.length > 0
        ? {
            tool_choice: preferToolName
              ? { type: 'function', function: { name: preferToolName } }
              : 'required',
          }
        : {}),
    };

    // NEW: log tool_call/result counts for stream requests
    const counts = this.getToolCounts(
      messages as Array<OpenAIMessage | OpenAIToolMessage>,
    );
    debugLogger.log(
      `[OpenAICompSend] (stream) tool_calls=${counts.calls}, tool_results=${counts.results}, missing_results=${counts.missingResults}, orphan_results=${counts.orphanResults}, missing_ids=${JSON.stringify(counts.missingIds)}, orphan_ids=${JSON.stringify(counts.orphanIds)}`,
    );
    // NEW: Always log the cURL, headers and body for reproducing requests (sanitized)
    try {
      const curl = this.buildCurlCommand(
        String(url || this.axios.defaults.baseURL || ''),
        this.axios.defaults.headers,
        requestBody,
      );
      debugLogger.log(`[OpenAI Debug] cURL: ${curl}`);
      debugLogger.log(
        `[OpenAI Debug] Request Body: ${this.stringifyForLog(requestBody)}`,
      );
      debugLogger.log(
        `[OpenAI Debug] Request Headers: ${this.stringifyForLog(this.axios.defaults.headers)}`,
      );
    } catch {
      // ignore
    }

    let response;
    try {
      response = await this.axios.post(url, requestBody, {
        responseType: 'stream',
      });
    } catch (error) {
      // 只在错误时打印详细调试信息
      const axiosError = error as {
        response?: { data?: unknown; status?: number };
        message?: string;
      };
      const status = axiosError.response?.status ?? 'unknown';
      let errorBody = '';
      const respData = axiosError.response?.data;
      if (typeof respData === 'string') {
        errorBody = respData;
      } else if (
        respData &&
        typeof (respData as { on?: unknown }).on === 'function'
      ) {
        errorBody = await this.readStreamToString(respData);
      } else {
        errorBody = this.stringifyForLog(respData || axiosError.message);
      }
      debugLogger.log(
        `[OpenAI Debug] Stream request failed with status ${status}`,
      );
      debugLogger.log(`[OpenAI Debug] Request URL: ${url}`);
      debugLogger.log(
        `[OpenAI Debug] Request Body: ${this.stringifyForLog(requestBody)}`,
      );
      debugLogger.log(
        `[OpenAI Debug] Request Headers: ${this.stringifyForLog(this.axios.defaults.headers)}`,
      );
      // NEW: include tool counts alongside error body
      debugLogger.log(
        `[OpenAI Debug] ToolCounts: calls=${counts.calls}, results=${counts.results}, missing_results=${counts.missingResults}, orphan_results=${counts.orphanResults}, missing_ids=${JSON.stringify(counts.missingIds)}, orphan_ids=${JSON.stringify(counts.orphanIds)}`,
      );
      // NEW: Log reproducible cURL when 400 occurs (sanitized)
      if (status === 400) {
        const curl = this.buildCurlCommand(
          String(url || this.axios.defaults.baseURL || ''),
          this.axios.defaults.headers,
          requestBody,
        );
        debugLogger.log(`[OpenAI Debug] cURL: ${curl}`);
      }
      debugLogger.log(`[OpenAI Debug] Error Response Body: ${errorBody}`);
      throw error;
    }

    // 解析 SSE 流
    for await (const chunk of this.parseSSEStream(response.data)) {
      const chunkData = chunk as {
        choices?: Array<{
          delta?: OpenAIChoiceDelta;
          finish_reason?: string | null;
        }>;
      };
      const delta = chunkData?.choices?.[0]?.delta as
        | OpenAIChoiceDelta
        | undefined;
      const finish = chunkData?.choices?.[0]?.finish_reason || null;

      if (delta?.content) {
        const emitParts: Part[] = delta.content
          ? [{ text: delta.content }]
          : [];
        const candidates: OpenAICandidate[] = [
          { content: { role: 'model', parts: emitParts }, index: 0 },
        ];
        yield new OpenAIGenerateContentResponse(candidates);
      }

      // Tool calls array (accumulate partial args across deltas)
      if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const buf = toolCallsBuffer.get(idx) || { arguments: '' };
          if (tc.id) buf.id = tc.id;
          if (tc.function?.name) buf.name = tc.function.name;
          if (tc.function?.arguments) buf.arguments += tc.function.arguments;
          toolCallsBuffer.set(idx, buf);
          try {
            if (buf.arguments.trim().endsWith('}')) {
              const args = JSON.parse(buf.arguments);
              const name = buf.name || 'tool';
              const emitParts: Part[] = [
                { functionCall: { name, args, id: buf.id } } as Part,
              ];
              const candidates: OpenAICandidate[] = [
                { content: { role: 'model', parts: emitParts }, index: 0 },
              ];
              yield new OpenAIGenerateContentResponse(candidates);
              toolCallsBuffer.delete(idx);
            }
          } catch {
            // ignore until complete JSON
          }
        }
      }

      if (finish) {
        sawFinish = true;
        const mapped =
          finish === 'stop'
            ? FinishReason.STOP
            : finish === 'length'
              ? FinishReason.MAX_TOKENS
              : finish === 'tool_calls' || finish === 'function_call'
                ? FinishReason.STOP
                : FinishReason.OTHER;
        const emitParts: Part[] = [];
        for (const [idx, buf] of toolCallsBuffer.entries()) {
          try {
            const args = buf.arguments ? JSON.parse(buf.arguments) : {};
            const name = buf.name || 'tool';
            emitParts.push({
              functionCall: { name, args, id: buf.id },
            } as Part);
            toolCallsBuffer.delete(idx);
          } catch {
            // ignore invalid JSON
          }
        }
        const candidates: OpenAICandidate[] = [
          {
            content: { role: 'model', parts: emitParts },
            index: 0,
            finishReason: mapped,
          },
        ];
        yield new OpenAIGenerateContentResponse(candidates);
      }
    }

    if (!sawFinish) {
      const candidates: OpenAICandidate[] = [
        {
          content: { role: 'model', parts: [] },
          index: 0,
          finishReason: FinishReason.STOP,
        },
      ];
      yield new OpenAIGenerateContentResponse(candidates);
    }
  }

  async countTokens(_req: CountTokensParameters): Promise<CountTokensResponse> {
    return { totalTokens: 0 };
  }

  async embedContent(
    _req: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return { embeddings: [] };
  }
}

// NEW: OpenAI message types used for request/response shaping
type OpenAIToolCall = {
  id: string;
  type: 'function';
  function: { name?: string; arguments: string };
};
type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  tool_calls?: OpenAIToolCall[];
};
type OpenAIToolMessage = {
  role: 'tool';
  tool_call_id: string;
  content: string;
};
