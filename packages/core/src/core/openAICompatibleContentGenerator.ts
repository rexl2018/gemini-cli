/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import { debugLogger } from '../utils/debugLogger.js';
import { retryWithBackoff, defaultShouldRetry } from '../utils/retry.js';
import type { ContentGenerator } from './contentGenerator.js';
import type { LLMProvider, ProviderConfig } from './providers/types.js';
import { createOpenAIProvider } from './providers/openai/openaiProviderFactory.js';

export interface OpenAIConfig {
  endpoint?: string;
  model: string;
  apiKey?: string;
  endpoint_postfix?: string;
  protocol?: 'responses_api' | 'chat_completion';
}

const DEFAULT_TIMEOUT_MS = 90_000;

export class OpenAICompatibleContentGenerator implements ContentGenerator {
  private provider: LLMProvider;
  private providerConfig: ProviderConfig;

  constructor(config: OpenAIConfig) {
    this.providerConfig = {
      providerId: 'openai',
      model: config.model,
      endpoint: config.endpoint,
      endpointPostfix: config.endpoint_postfix,
      apiKey: config.apiKey,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      useResponsesApi: this.shouldUseResponsesApi(config.protocol),
    };
    debugLogger.log(
      `[BYOK] OpenAI provider created with endpoint=${config.endpoint}, postfix=${config.endpoint_postfix}, model=${config.model}, protocol=${config.protocol ?? 'responses_api'}`,
    );
    this.provider = createOpenAIProvider(this.providerConfig);
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    this.refreshProviderIfNeeded();
    debugLogger.log(
      `[BYOK] generateContent model=${request.model} promptId=${userPromptId} payloadParts=${Array.isArray(request.contents) ? request.contents.length : 1}`,
    );
    return this.executeWithRetry(
      () => this.provider.generate(request, userPromptId),
      request.model,
      userPromptId,
    );
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    this.refreshProviderIfNeeded();
    debugLogger.log(
      `[BYOK] generateContentStream model=${request.model} promptId=${userPromptId} payloadParts=${Array.isArray(request.contents) ? request.contents.length : 1}`,
    );
    const stream = await this.executeWithRetry(
      () => this.provider.generateStream(request, userPromptId),
      request.model,
      userPromptId,
    );
    return this.wrapStream(stream, request.model, userPromptId);
  }

  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    model: string,
    promptId: string,
  ): Promise<T> {
    try {
      const result = await retryWithBackoff(fn, {
        shouldRetryOnError: (error) =>
          this.shouldRetryOnError(error, model, promptId),
      });
      debugLogger.log(
        `[BYOK] request success model=${model} promptId=${promptId}`,
      );
      return result;
    } catch (error) {
      debugLogger.error(
        `[BYOK] request failed model=${model} promptId=${promptId}: ${(error as Error)?.message ?? error}`,
      );
      throw error;
    }
  }

  private shouldRetryOnError(
    error: unknown,
    model: string,
    promptId: string,
  ): boolean {
    if (!error || typeof error !== 'object') {
      return defaultShouldRetry(error as Error);
    }

    const maybeError = error as { code?: unknown; message?: unknown };
    const code =
      typeof maybeError.code === 'string' ? maybeError.code : undefined;
    const message =
      typeof maybeError.message === 'string' ? maybeError.message : undefined;

    const isTimeout =
      code === 'ECONNABORTED' ||
      (message !== undefined && message.toLowerCase().includes('timeout'));

    if (isTimeout) {
      debugLogger.warn(
        `[BYOK] timeout encountered model=${model} promptId=${promptId}; retrying...`,
        error,
      );
      return true;
    }

    return defaultShouldRetry(error as Error);
  }

  private async *wrapStream(
    stream: AsyncGenerator<GenerateContentResponse>,
    model: string,
    promptId: string,
  ): AsyncGenerator<GenerateContentResponse> {
    try {
      for await (const chunk of stream) {
        yield chunk;
      }
      debugLogger.log(
        `[BYOK] generateContentStream completed model=${model} promptId=${promptId}`,
      );
    } catch (error) {
      debugLogger.error(
        `[BYOK] generateContentStream error model=${model} promptId=${promptId}: ${(error as Error)?.message ?? error}`,
      );
      throw error;
    }
  }

  private refreshProviderIfNeeded(): void {
    // Protocol is defined at construction time; no dynamic refresh required.
  }

  countTokens(request: CountTokensParameters): Promise<CountTokensResponse> {
    return this.provider.countTokens(request);
  }

  embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse> {
    return this.provider.embedContent(request);
  }

  private shouldUseResponsesApi(
    protocol: 'responses_api' | 'chat_completion' | undefined,
  ): boolean {
    if (protocol) {
      return protocol === 'responses_api';
    }
    const v = process.env['LLM_BYOK_RESPONSE_API'];
    return !!v && v !== '0';
  }
}
