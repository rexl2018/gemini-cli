/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { FinishReason } from '@google/genai';
import type { GenerateContentResponse, Part } from '@google/genai';
import { OpenAIGenerateContentResponse } from './responseModel.js';
import type { OpenAIResponseLike } from '../types/internalTypes.js';
import { debugLogger } from '../../../../utils/debugLogger.js';
import { stringifyForLog } from './diagnostics.js';

export function convertFromOpenAIResponse(
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
      // ignore malformed JSON and fall back to empty args
    }
    parts.push({ functionCall: { name, args, id: tc.id } } as Part);
  }
  const candidates = [
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

export function convertFromResponsesApi(
  resData: unknown,
): GenerateContentResponse {
  const data = resData as Record<string, unknown> | undefined;
  const output = (data?.['output'] ?? []) as Array<Record<string, unknown>>;
  const parts: Part[] = [];

  for (const item of output) {
    const type = String(item['type'] ?? '');
    if (type === 'output_text') {
      const text = String(item['text'] ?? '');
      if (text) parts.push({ text });
    } else if (type === 'message') {
      const contentArr = (item['content'] ?? []) as Array<
        Record<string, unknown>
      >;
      for (const c of contentArr) {
        const ctype = String(c['type'] ?? '');
        if (ctype === 'output_text') {
          const text = String(c['text'] ?? '');
          if (text) parts.push({ text });
        } else if (ctype === 'tool_call' || ctype === 'function_call') {
          parts.push(parseResponsesFunctionCall(c));
        }
      }
    } else if (type === 'tool_call' || type === 'function_call') {
      parts.push(parseResponsesFunctionCall(item));
    }
  }

  try {
    const toolParts = parts.filter(
      (p) => !!(p as { functionCall?: unknown }).functionCall,
    );
    if (toolParts.length > 0) {
      debugLogger.log(
        `[OpenAICompRecv] (responses) tool_calls=${stringifyForLog(toolParts)}`,
      );
    } else {
      debugLogger.log('[OpenAICompRecv] (responses) tool_calls=0');
    }
  } catch {
    // ignore logging errors
  }

  const candidates = [
    {
      content: { role: 'model', parts },
      index: 0,
      finishReason: FinishReason.STOP,
    },
  ];

  const usageRaw = data?.['usage'] as Record<string, unknown> | undefined;
  const usage = (() => {
    if (!usageRaw) {
      return undefined;
    }

    const prompt = coerceNumber(
      usageRaw['input_token_count'] ?? usageRaw['input_tokens'] ?? 0,
    );
    const candidates = coerceNumber(
      usageRaw['output_token_count'] ?? usageRaw['output_tokens'] ?? 0,
    );
    const totalRaw =
      usageRaw['total_token_count'] ?? usageRaw['total_tokens'] ?? undefined;
    const total =
      totalRaw !== undefined ? coerceNumber(totalRaw) : prompt + candidates;

    return {
      promptTokenCount: prompt,
      candidatesTokenCount: candidates,
      totalTokenCount: total,
    };
  })();

  const response = new OpenAIGenerateContentResponse(candidates, usage);
  if (typeof data?.['response_id'] === 'string') {
    response.responseId = String(data['response_id']);
  }
  return response;
}

function coerceNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseResponsesFunctionCall(item: Record<string, unknown>): Part {
  const name = String(item['name'] ?? 'tool');
  const id = String(item['call_id'] ?? item['id'] ?? '');
  let args: Record<string, unknown> = {};
  const rawArgs = item['arguments'];
  try {
    if (typeof rawArgs === 'string') args = JSON.parse(rawArgs);
    else if (typeof rawArgs === 'object' && rawArgs)
      args = rawArgs as Record<string, unknown>;
  } catch {
    // ignore parse errors and use empty args
  }
  return { functionCall: { name, args, id } } as Part;
}
