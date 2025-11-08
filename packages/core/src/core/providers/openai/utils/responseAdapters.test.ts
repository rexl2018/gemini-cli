/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { convertFromResponsesApi } from './responseAdapters.js';

describe('convertFromResponsesApi usage metadata', () => {
  it('reads legacy *_token_count fields', () => {
    const response = convertFromResponsesApi({
      output: [],
      usage: {
        input_token_count: 12,
        output_token_count: 7,
        total_token_count: 21,
      },
    });

    expect(response.usageMetadata?.promptTokenCount).toBe(12);
    expect(response.usageMetadata?.candidatesTokenCount).toBe(7);
    expect(response.usageMetadata?.totalTokenCount).toBe(21);
  });

  it('reads *_tokens fields and falls back to summing totals when missing', () => {
    const response = convertFromResponsesApi({
      output: [],
      usage: {
        input_tokens: '11',
        output_tokens: 5,
      },
    });

    expect(response.usageMetadata?.promptTokenCount).toBe(11);
    expect(response.usageMetadata?.candidatesTokenCount).toBe(5);
    expect(response.usageMetadata?.totalTokenCount).toBe(16);
  });
});
