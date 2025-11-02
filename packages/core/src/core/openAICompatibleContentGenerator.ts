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
    function?: { name?: string; arguments?: string };
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
    const lastToolCallIdByName = new Map<string, string>();
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
          if (name) {
            lastToolCallIdByName.set(name, id);
          }
          return {
            id,
            type: 'function',
            function: {
              name,
              arguments: JSON.stringify(fc.args || {}),
            },
          };
        });

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
        if (text && text.trim()) {
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
          const toolCallId =
            fr.id ||
            (fr.name ? lastToolCallIdByName.get(fr.name) : undefined) ||
            genToolCallId(fr.name);
          if (fr.name) {
            lastToolCallIdByName.set(fr.name, toolCallId);
          }
          out.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: payload,
          });
        }
      }
    }

    return out;
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
        finishReason: ((): FinishReason | undefined => {
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

    const requestBody = {
      model: this.config.model,
      messages,
      temperature: req.config?.temperature,
      max_tokens: req.config?.maxOutputTokens,
      top_p: req.config?.topP,
      stream: false,
      ...(tools ? { tools } : {}),
    };

    const response = await this.axios.post('', requestBody);

    debugLogger.log(
      `[OpenAICompRaw] response: ${this.stringifyForLog(response.data)}`,
    );
    return this.convertFromOpenAIResponse(response.data as OpenAIResponseLike);
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

    let sawFinish = false;
    const toolCallsBuffer = new Map<
      number,
      { id?: string; name?: string; arguments: string }
    >();

    const requestBody = {
      model: this.config.model,
      messages,
      temperature: req.config?.temperature,
      max_tokens: req.config?.maxOutputTokens,
      top_p: req.config?.topP,
      stream: true,
      ...(tools ? { tools } : {}),
    };

    const response = await this.axios.post('', requestBody, {
      responseType: 'stream',
    });

    // 解析 SSE 流
    for await (const chunk of this.parseSSEStream(response.data)) {
      const delta = chunk?.choices?.[0]?.delta as OpenAIChoiceDelta | undefined;
      const finish = chunk?.choices?.[0]?.finish_reason || null;

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
