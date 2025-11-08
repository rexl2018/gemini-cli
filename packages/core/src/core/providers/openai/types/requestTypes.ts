/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OpenAIMessage, OpenAIToolMessage } from '../utils/tools.js';

export type OpenAIMessagesRequest = OpenAIMessage | OpenAIToolMessage;

export interface ChatCompletionsRequestBody {
  model: string;
  messages: OpenAIMessagesRequest[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  tools?: Array<{
    type: 'function';
    function: { name?: string; description?: string; parameters: unknown };
  }>;
  tool_choice?:
    | 'none'
    | 'auto'
    | 'required'
    | { type: 'function'; function: { name: string } };
}

export interface ResponsesRequestBody {
  model: string;
  input: Array<
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
  >;
  max_output_tokens?: number;
  tools?: Array<{
    type: 'function';
    name?: string;
    description?: string;
    parameters?: unknown;
  }>;
  tool_choice?:
    | 'none'
    | 'auto'
    | 'required'
    | { type: 'function'; function: { name: string } }
    | { type: 'function'; name: string };
}
