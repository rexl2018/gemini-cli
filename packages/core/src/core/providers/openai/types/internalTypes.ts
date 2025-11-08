/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface OpenAIChoiceDelta {
  content?: string;
  function_call?: { name?: string; arguments?: string };
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

export interface OpenAIChoiceMessage {
  content?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments: string };
  }>;
}

export interface OpenAIChoice {
  message?: OpenAIChoiceMessage;
  finish_reason?: string | null;
  delta?: OpenAIChoiceDelta;
}

export interface OpenAIResponseLike {
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}
