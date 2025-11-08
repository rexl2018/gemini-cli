/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mock } from 'vitest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { histCommand } from './histCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext } from './types.js';
import { MessageType } from '../types.js';
import type { Content } from '@google/genai';

const MAX_HISTORY_LINE_LENGTH = 2000;
const ELLIPSIS = '…';

const makeContent = (role: Content['role'], text: string): Content => ({
  role,
  parts: [{ text }],
});

describe('histCommand', () => {
  let mockContext: CommandContext;
  let mockGetChat: Mock;
  let mockSetHistory: Mock;

  beforeEach(() => {
    vi.clearAllMocks();

    mockGetChat = vi.fn();
    mockSetHistory = vi.fn();
    mockContext = createMockCommandContext({
      services: {
        config: {
          getGeminiClient: () => ({
            getChat: mockGetChat,
            setHistory: mockSetHistory,
          }),
        },
      },
    });
  });

  it('truncates long history entries for /hist list', async () => {
    const listCommand = histCommand.subCommands?.find(
      (command) => command.name === 'list',
    );
    if (!listCommand?.action) {
      throw new Error('list command must have an action');
    }

    const longText = 'A'.repeat(2100);
    const history: Content[] = [makeContent('model', longText)];

    mockGetChat.mockResolvedValue({
      getHistory: () => history,
    });

    await listCommand.action(mockContext, '');

    const addItemMock = mockContext.ui.addItem as Mock;
    expect(addItemMock).toHaveBeenCalledTimes(1);
    const [message] = addItemMock.mock.calls[0] ?? [];
    const text = (message?.text as string | undefined) ?? '';

    expect(message?.type).toBe(MessageType.INFO);
    expect(text.startsWith('1. [model] ')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_HISTORY_LINE_LENGTH);
    expect(text.endsWith(ELLIPSIS)).toBe(true);
  });

  it('applies truncation when /hist listn outputs the last entries', async () => {
    const listnCommand = histCommand.subCommands?.find(
      (command) => command.name === 'listn',
    );
    if (!listnCommand?.action) {
      throw new Error('listn command must have an action');
    }

    const shortText = 'short model response';
    const longText = 'B'.repeat(2101);
    const history: Content[] = [
      makeContent('user', 'user prompt'),
      makeContent('model', shortText),
      makeContent('model', longText),
    ];

    mockGetChat.mockResolvedValue({
      getHistory: () => history,
    });

    await listnCommand.action(mockContext, '2');

    const addItemMock = mockContext.ui.addItem as Mock;
    expect(addItemMock).toHaveBeenCalledTimes(2);

    const firstCall = addItemMock.mock.calls[0] ?? [];
    const secondCall = addItemMock.mock.calls[1] ?? [];

    const firstText = (firstCall[0]?.text as string | undefined) ?? '';
    const truncatedText = (secondCall[0]?.text as string | undefined) ?? '';

    expect(firstText).toBe(`2. [model] ${shortText}`);
    expect(firstText.endsWith(ELLIPSIS)).toBe(false);

    expect(truncatedText.startsWith('3. [model] ')).toBe(true);
    expect(truncatedText.length).toBe(MAX_HISTORY_LINE_LENGTH);
    expect(truncatedText.endsWith(ELLIPSIS)).toBe(true);
  });

  describe('delete subcommands', () => {
    it('deletes entries after given index with del-after', async () => {
      const delAfterCommand = histCommand.subCommands?.find(
        (command) => command.name === 'del-after',
      );
      if (!delAfterCommand?.action) {
        throw new Error('del-after command must have an action');
      }

      const history: Content[] = [
        makeContent('user', 'first'),
        makeContent('model', 'second'),
        makeContent('model', 'third'),
      ];

      mockGetChat.mockResolvedValue({
        getHistory: () => history,
      });
      mockSetHistory.mockResolvedValue(undefined);

      const result = await delAfterCommand.action(mockContext, '2');

      expect(mockSetHistory).toHaveBeenCalledWith([history[0]]);
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'Conversation history entries from #2 to #3 deleted.',
      });
    });

    it('deletes the last N entries with del-last', async () => {
      const delLastCommand = histCommand.subCommands?.find(
        (command) => command.name === 'del-last',
      );
      if (!delLastCommand?.action) {
        throw new Error('del-last command must have an action');
      }

      const history: Content[] = [
        makeContent('user', 'first'),
        makeContent('model', 'second'),
        makeContent('model', 'third'),
        makeContent('model', 'fourth'),
      ];

      mockGetChat.mockResolvedValue({
        getHistory: () => history,
      });
      mockSetHistory.mockResolvedValue(undefined);

      const result = await delLastCommand.action(mockContext, '2');

      expect(mockSetHistory).toHaveBeenCalledWith([history[0], history[1]]);
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'Last 2 entries deleted from conversation history.',
      });
    });

    it('deletes a range of entries with del-range', async () => {
      const delRangeCommand = histCommand.subCommands?.find(
        (command) => command.name === 'del-range',
      );

      if (!delRangeCommand?.action) {
        throw new Error('del-range command must have an action');
      }

      const history: Content[] = [
        makeContent('user', 'first'),

        makeContent('model', 'second'),

        makeContent('model', 'third'),

        makeContent('model', 'fourth'),
      ];

      mockGetChat.mockResolvedValue({
        getHistory: () => history,
      });

      mockSetHistory.mockResolvedValue(undefined);

      const result = await delRangeCommand.action(mockContext, '2,3');

      expect(mockSetHistory).toHaveBeenCalledWith([history[0], history[3]]);

      expect(result).toEqual({
        type: 'message',

        messageType: 'info',

        content: 'Conversation history entries from #2 to #3 deleted.',
      });
    });

    it('deletes entries up to index with del-before', async () => {
      const delBeforeCommand = histCommand.subCommands?.find(
        (command) => command.name === 'del-before',
      );

      if (!delBeforeCommand?.action) {
        throw new Error('del-before command must have an action');
      }

      const history: Content[] = [
        makeContent('user', 'first'),

        makeContent('model', 'second'),

        makeContent('model', 'third'),
      ];

      mockGetChat.mockResolvedValue({
        getHistory: () => history,
      });

      mockSetHistory.mockResolvedValue(undefined);

      const result = await delBeforeCommand.action(mockContext, '2');

      expect(mockSetHistory).toHaveBeenCalledWith([history[2]]);

      expect(result).toEqual({
        type: 'message',

        messageType: 'info',

        content: 'Conversation history entries from #1 to #2 deleted.',
      });
    });
  });
});
