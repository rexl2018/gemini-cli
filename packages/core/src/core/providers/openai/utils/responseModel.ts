/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  FinishReason,
  GenerateContentResponse,
  Part,
  FunctionCall,
} from '@google/genai';

export type OpenAICandidate = {
  content: {
    role: string;
    parts: Part[];
  };
  index: number;
  finishReason?: FinishReason;
};

export class OpenAIGenerateContentResponse implements GenerateContentResponse {
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
