/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FinishReason,
  type CountTokensParameters,
  type CountTokensResponse,
  type EmbedContentParameters,
  type EmbedContentResponse,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Content,
} from '@google/genai';
import type { AxiosInstance } from 'axios';
import type {
  LLMProvider,
  ProviderCapability,
  ProviderConfig,
} from '../../types.js';
import type {
  OpenAIMessagesRequest,
  ChatCompletionsRequestBody,
} from '../types/requestTypes.js';
import {
  convertToolsToOpenAIFormat,
  convertToolsToResponsesFormat,
  getToolCounts,
} from '../utils/tools.js';
import {
  logConversation,
  logToolCounts,
  logCurl,
  logHeaders,
} from '../utils/logging.js';
import {
  buildCurlCommand,
  stringifyForLog,
  readStreamToString,
} from '../utils/diagnostics.js';
import {
  toOpenAIMessages,
  buildResponsesInputFromMessages,
} from '../utils/messages.js';
import {
  convertFromOpenAIResponse,
  convertFromResponsesApi,
} from '../utils/responseAdapters.js';
import { parseSSEStream } from '../utils/streaming.js';
import type { OpenAIChoiceDelta } from '../types/internalTypes.js';
import { debugLogger } from '../../../../utils/debugLogger.js';
import { OpenAIGenerateContentResponse } from '../utils/responseModel.js';
import type { Part } from '@google/genai';

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

interface OpenAIChatProviderDeps {
  axios: AxiosInstance;
  config: ProviderConfig;
  capability: ProviderCapability;
}

export class OpenAIChatProvider implements LLMProvider {
  capability: ProviderCapability;

  private readonly axios: AxiosInstance;
  private readonly config: ProviderConfig;

  constructor({ axios, config, capability }: OpenAIChatProviderDeps) {
    this.axios = axios;
    this.config = { ...config };
    this.capability = capability;
  }

  async generate(
    req: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const { messages, contentsArray } = this.prepareMessages(req);
    logConversation(contentsArray);

    if (req.config?.systemInstruction) {
      messages.unshift({
        role: 'system',
        content:
          typeof req.config.systemInstruction === 'string'
            ? req.config.systemInstruction
            : (req.config.systemInstruction as { text?: string }).text || '',
      });
    }

    const tools = convertToolsToOpenAIFormat(req.config?.tools);
    const preferToolName = this.inferPreferredTool(messages);

    const useResponses = this.config.useResponsesApi === true;
    const url = this.getTargetURL(useResponses);
    debugLogger.log(
      `[OpenAIComp] Mode: Responses API=${useResponses}; Final URL=${url}`,
    );

    const requestBody = useResponses
      ? this.buildResponsesRequestBody(req, messages, preferToolName)
      : this.buildChatRequestBody(req, messages, tools, preferToolName);

    const counts = getToolCounts(messages as OpenAIMessagesRequest[]);
    logToolCounts(counts);

    try {
      const curl = buildCurlCommand(
        String(url || this.axios.defaults.baseURL || ''),
        this.axios.defaults.headers,
        requestBody,
      );
      logCurl(curl);
      debugLogger.log(
        `[OpenAI Debug] Request Body: ${stringifyForLog(requestBody)}`,
      );
      logHeaders(this.axios.defaults.headers);
      const sentTools = useResponses
        ? convertToolsToResponsesFormat(req.config?.tools)
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
      // ignore logging errors
    }

    try {
      const response = await this.axios.post(url, requestBody);
      debugLogger.log(
        `[OpenAICompRaw] response: ${stringifyForLog(response.data)}`,
      );
      if (useResponses && !this.hasResponsesToolCalls(response.data)) {
        debugLogger.log(
          '[OpenAIComp] No tool_call in Responses result; falling back to chat/completions for tool calling',
        );
        const chatUrl = this.getTargetURL(false);
        const chatBody = this.buildChatRequestBody(
          req,
          messages,
          tools,
          preferToolName,
        );
        const chatResp = await this.axios.post(chatUrl, chatBody);
        debugLogger.log(
          `[OpenAICompRaw] (fallback chat) response: ${stringifyForLog(chatResp.data)}`,
        );
        return convertFromOpenAIResponse(chatResp.data);
      }
      return useResponses
        ? convertFromResponsesApi(response.data)
        : convertFromOpenAIResponse(response.data);
    } catch (error) {
      await this.handleError(error, url, requestBody, counts);
      throw error;
    }
  }

  async generateStream(
    req: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    return this._generateContentStream(req);
  }

  private async *_generateContentStream(
    req: GenerateContentParameters,
  ): AsyncGenerator<GenerateContentResponse> {
    const { messages, contentsArray } = this.prepareMessages(req);
    logConversation(contentsArray);

    if (req.config?.systemInstruction) {
      messages.unshift({
        role: 'system',
        content:
          typeof req.config.systemInstruction === 'string'
            ? req.config.systemInstruction
            : (req.config.systemInstruction as { text?: string }).text || '',
      });
    }

    const tools = convertToolsToOpenAIFormat(req.config?.tools);
    const preferToolName = this.inferPreferredTool(messages);

    let sawFinish = false;
    const toolCallsBuffer = new Map<
      number,
      { id?: string; name?: string; arguments: string }
    >();
    const useResponses = this.config.useResponsesApi === true;
    const url = this.getTargetURL(useResponses);
    debugLogger.log(
      `[OpenAIComp] Mode(stream): Responses API=${useResponses}; Final URL=${url}`,
    );

    if (useResponses) {
      const requestBody = this.buildResponsesRequestBody(
        req,
        messages,
        preferToolName,
      );
      this.logRequest(url, requestBody);

      try {
        const response = await this.axios.post(url, requestBody);
        debugLogger.log(
          `[OpenAICompRaw] (responses stream-single) response: ${stringifyForLog(response.data)}`,
        );
        const converted = convertFromResponsesApi(response.data);
        yield converted;
        return;
      } catch (error) {
        await this.handleError(error, url, requestBody);
        throw error;
      }
    }

    const requestBody = this.buildChatRequestBody(
      req,
      messages,
      tools,
      preferToolName,
      true,
    );

    const counts = getToolCounts(messages as OpenAIMessagesRequest[]);
    logToolCounts(counts, 'stream');
    this.logRequest(url, requestBody);

    let response;
    try {
      response = await this.axios.post(url, requestBody, {
        responseType: 'stream',
      });
    } catch (error) {
      await this.handleError(error, url, requestBody, counts);
      throw error;
    }

    for await (const chunk of parseSSEStream(response.data)) {
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
        const candidates = [
          { content: { role: 'model', parts: emitParts }, index: 0 },
        ];
        yield new OpenAIGenerateContentResponse(candidates);
      }

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
              const candidates = [
                { content: { role: 'model', parts: emitParts }, index: 0 },
              ];
              yield new OpenAIGenerateContentResponse(candidates);
              toolCallsBuffer.delete(idx);
            }
          } catch {
            // ignore until JSON is complete
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
        const candidates = [
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
      const candidates = [
        {
          content: { role: 'model', parts: [] },
          index: 0,
          finishReason: FinishReason.STOP,
        },
      ];
      yield new OpenAIGenerateContentResponse(candidates);
    }
  }

  countTokens(_request: CountTokensParameters): Promise<CountTokensResponse> {
    return Promise.resolve({ totalTokens: 0 });
  }

  embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return Promise.resolve({ embeddings: [] });
  }

  private prepareMessages(req: GenerateContentParameters): {
    messages: ReturnType<typeof toOpenAIMessages>;
    contentsArray: Content[];
  } {
    const messages = toOpenAIMessages(req.contents);
    const contentsArray: Content[] = (() => {
      const c = req.contents as unknown;
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
    return { messages, contentsArray };
  }

  private inferPreferredTool(
    messages: ReturnType<typeof toOpenAIMessages>,
  ): string | undefined {
    try {
      for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
        const message = messages?.[i];
        const role = (message as { role?: string }).role;
        if (role !== 'user') continue;
        const content = (message as { content?: string }).content || '';
        const normalized = content.toLowerCase();
        if (normalized.includes('use read_file')) {
          return 'read_file';
        }
        break;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private buildChatRequestBody(
    req: GenerateContentParameters,
    messages: ReturnType<typeof toOpenAIMessages>,
    tools: ReturnType<typeof convertToolsToOpenAIFormat>,
    preferToolName: string | undefined,
    stream = false,
  ): ChatCompletionsRequestBody {
    return {
      model: this.config.model,
      messages,
      temperature: req.config?.temperature,
      max_tokens: req.config?.maxOutputTokens,
      top_p: req.config?.topP,
      stream,
      ...(tools ? { tools } : {}),
      ...(tools && tools.length > 0 && preferToolName
        ? {
            tool_choice: {
              type: 'function',
              function: { name: preferToolName },
            },
          }
        : {}),
    };
  }

  private buildResponsesRequestBody(
    req: GenerateContentParameters,
    messages: ReturnType<typeof toOpenAIMessages>,
    preferToolName: string | undefined,
  ) {
    return {
      model: this.config.model,
      input: buildResponsesInputFromMessages(messages),
      max_output_tokens:
        req.config?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(convertToolsToResponsesFormat(req.config?.tools)
        ? { tools: convertToolsToResponsesFormat(req.config?.tools) }
        : {}),
      ...(preferToolName
        ? { tool_choice: { type: 'function', name: preferToolName } }
        : {}),
    };
  }

  private getTargetURL(useResponses: boolean): string {
    const base = String(this.axios.defaults.baseURL || '');
    if (!base) return '';
    let url = base;
    if (useResponses) {
      url = url.includes('/v2/crawl')
        ? url.replace(/\/v2\/crawl\/?/, '/responses')
        : url;
    } else {
      url = url.includes('/responses')
        ? url.replace(/\/responses\/?/, '/v2/crawl')
        : url;
    }
    url = url
      .replace('/responses/?', '/responses?')
      .replace('/v2/crawl/?', '/v2/crawl?');
    return url;
  }

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

  private logRequest(url: string, requestBody: unknown): void {
    try {
      const curl = buildCurlCommand(
        String(url || this.axios.defaults.baseURL || ''),
        this.axios.defaults.headers,
        requestBody,
      );
      logCurl(curl);
      debugLogger.log(
        `[OpenAI Debug] Request Body: ${stringifyForLog(requestBody)}`,
      );
      logHeaders(this.axios.defaults.headers);
    } catch {
      // ignore logging errors
    }
  }

  private async handleError(
    error: unknown,
    url: string,
    requestBody: unknown,
    counts?: ReturnType<typeof getToolCounts>,
  ): Promise<void> {
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
      errorBody = await readStreamToString(respData);
    } else {
      errorBody = stringifyForLog(respData || axiosError.message);
    }
    debugLogger.log(`[OpenAI Debug] Request failed with status ${status}`);
    debugLogger.log(
      `[OpenAI Debug] Request URL: ${url || this.axios.defaults.baseURL}`,
    );
    debugLogger.log(
      `[OpenAI Debug] Request Body: ${stringifyForLog(requestBody)}`,
    );
    logHeaders(this.axios.defaults.headers);
    if (counts) {
      logToolCounts(counts);
    }
    if (status === 400) {
      const curl = buildCurlCommand(
        String(url || this.axios.defaults.baseURL || ''),
        this.axios.defaults.headers,
        requestBody,
      );
      logCurl(curl);
    }
    debugLogger.log(`[OpenAI Debug] Error Response Body: ${errorBody}`);
  }
}
