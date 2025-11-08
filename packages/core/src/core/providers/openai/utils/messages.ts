/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Content,
  ContentListUnion,
  Part,
  FunctionCall,
} from '@google/genai';

export type NormalizedMessage =
  | {
      role: 'system' | 'user' | 'assistant' | 'developer';
      content: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name?: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export function toOpenAIMessages(contents: ContentListUnion): Array<
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
  if (typeof contents === 'string') {
    return [{ role: 'user', content: contents }];
  }

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
        .map((p) => (p as { text: string }).text)
        .join('\n');
      return text ? [{ role: 'system', content: text }] : [];
    }
  }

  const list: Content[] = Array.isArray(contents)
    ? (contents as Content[])
    : [contents as Content];
  type ToolCall = {
    id: string;
    type: 'function';
    function: { name?: string; arguments: string };
  };
  type OpenAIOpenMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
    tool_calls?: ToolCall[];
  };
  type ToolMsg = {
    role: 'tool';
    tool_call_id: string;
    content: string;
  };

  const out: Array<OpenAIOpenMessage | ToolMsg> = [];
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
      .filter((p) => typeof (p as { text?: unknown }).text === 'string')
      .map((p) => (p as { text: string }).text)
      .filter(Boolean)
      .join('\n\n');

    const tool_calls: ToolCall[] = parts
      .filter(
        (p) => (p as { functionCall?: unknown }).functionCall !== undefined,
      )
      .map((p) => {
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

    const hasFunctionResponse = parts.some(
      (p) =>
        (p as { functionResponse?: unknown }).functionResponse !== undefined,
    );

    if (role === 'assistant') {
      const message: OpenAIOpenMessage = {
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
        ) {
          payload = (resp as { llmContent: string }).llmContent;
        } else if (
          resp &&
          typeof (resp as { output?: unknown }).output === 'string'
        ) {
          payload = (resp as { output: string }).output;
        } else if (
          resp &&
          typeof (resp as { result?: unknown }).result === 'string'
        ) {
          payload = (resp as { result: string }).result;
        } else if (
          resp &&
          typeof (resp as { error?: unknown }).error === 'string'
        ) {
          payload = (resp as { error: string }).error;
        } else {
          try {
            payload = JSON.stringify(resp ?? fr);
          } catch {
            payload = '[functionResponse]';
          }
        }

        let toolCallId: string | undefined = fr.id;
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
          continue;
        }
        usedToolCallIds.add(toolCallId);
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
  }

  if (allToolCallIds.size > usedToolCallIds.size) {
    const unmatchedIds = new Set<string>();
    for (const id of allToolCallIds) {
      if (!usedToolCallIds.has(id)) unmatchedIds.add(id);
    }
    if (unmatchedIds.size > 0) {
      for (let i = 0; i < out.length; i++) {
        const msg = out[i];
        if (msg && (msg as { role: string }).role === 'assistant') {
          const m = msg as OpenAIOpenMessage;
          if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            m.tool_calls = m.tool_calls.filter(
              (tc) => !unmatchedIds.has(tc.id),
            );
          }
        }
      }
    }
  }

  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i] as ToolMsg | OpenAIOpenMessage;
    if (msg && (msg as { role: string }).role === 'tool') {
      const toolMsg = msg as ToolMsg;
      if (!toolMsg.tool_call_id || !allToolCallIds.has(toolMsg.tool_call_id)) {
        out.splice(i, 1);
      }
    }
  }

  return out;
}

export function buildResponsesInputFromMessages(
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
      if (typeof text === 'string' && text.trim().length > 0) {
        const contentType = role === 'assistant' ? 'output_text' : 'input_text';
        input.push({
          role,
          content: [{ type: contentType, text: text.trim() }],
        });
      }
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

  if (input.length === 0) {
    input.push({ role: 'user', content: [{ type: 'input_text', text: '' }] });
  }

  return input;
}

export function extractTextFromCandidate(parts: Part[]): string {
  return parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('');
}

export function extractFunctionCalls(
  parts: Part[],
): FunctionCall[] | undefined {
  const fcs = parts
    .filter((part) => (part as { functionCall?: unknown }).functionCall)
    .map((part) => (part as { functionCall: FunctionCall }).functionCall);
  return fcs.length > 0 ? fcs : undefined;
}
