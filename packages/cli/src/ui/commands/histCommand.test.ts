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

  it('truncates long history entries for /hist listall', async () => {
    const listallCommand = histCommand.subCommands?.find(
      (command) => command.name === 'listall',
    );
    if (!listallCommand?.action) {
      throw new Error('listall command must have an action');
    }

    const longText = 'A'.repeat(2100);
    const history: Content[] = [makeContent('model', longText)];

    mockGetChat.mockResolvedValue({
      getHistory: () => history,
    });

    await listallCommand.action(mockContext, '');

    const addItemMock = mockContext.ui.addItem as Mock;
    expect(addItemMock).toHaveBeenCalledTimes(1);
    const [message] = addItemMock.mock.calls[0] ?? [];
    const text = (message?.text as string | undefined) ?? '';

    expect(message?.type).toBe(MessageType.INFO);
    expect(text.startsWith('1. [model] ')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_HISTORY_LINE_LENGTH);
    expect(text.endsWith(ELLIPSIS)).toBe(true);
  });

  it('applies truncation when /hist ll outputs the last entries', async () => {
    const llCommand = histCommand.subCommands?.find(
      (command) => command.name === 'll',
    );
    if (!llCommand?.action) {
      throw new Error('ll command must have an action');
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

    await llCommand.action(mockContext, '2');

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

  it('lists entries around the Nth entry for /hist la', async () => {
    const laCommand = histCommand.subCommands?.find(
      (command) => command.name === 'la',
    );
    if (!laCommand?.action) {
      throw new Error('la command must have an action');
    }

    const history: Content[] = [
      makeContent('user', 'entry 1'),
      makeContent('model', 'entry 2'),
      makeContent('user', 'entry 3'),
      makeContent('model', 'entry 4'),
      makeContent('user', 'entry 5'),
      makeContent('model', 'entry 6'),
      makeContent('user', 'entry 7'),
      makeContent('model', 'entry 8'),
      makeContent('user', 'entry 9'),
      makeContent('model', 'entry 10'),
    ];

    mockGetChat.mockResolvedValue({
      getHistory: () => history,
    });

    await laCommand.action(mockContext, '5');

    const addItemMock = mockContext.ui.addItem as Mock;
    // Should list 5 entries: 3,4,5,6,7
    expect(addItemMock).toHaveBeenCalledTimes(5);

    // Check each entry is listed correctly
    const calls = addItemMock.mock.calls;
    expect(calls[0][0].text).toBe('3. [user] entry 3');
    expect(calls[1][0].text).toBe('4. [model] entry 4');
    expect(calls[2][0].text).toBe('5. [user] entry 5');
    expect(calls[3][0].text).toBe('6. [model] entry 6');
    expect(calls[4][0].text).toBe('7. [user] entry 7');
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
