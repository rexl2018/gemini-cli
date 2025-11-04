/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, MessageActionReturn } from './types.js';
import { CommandKind } from './types.js';
import type { Content } from '@google/genai';
import { MessageType } from '../types.js';

function contentText(content: Content): string {
  const parts = content.parts ?? [];
  const text = parts
    .map((part) => {
      if (part && typeof part === 'object') {
        if ('text' in part && part.text) return part.text;
        if ('functionCall' in part && part.functionCall)
          return `FunctionCall: ${JSON.stringify(part.functionCall)}`;
        if ('functionResponse' in part && part.functionResponse)
          return `FunctionResponse: ${JSON.stringify(part.functionResponse)}`;
      }
      return '';
    })
    .join('');
  return text;
}

function formatHistoryLine(index: number, content: Content): string {
  const role = content.role ?? 'model';
  const text = contentText(content);
  return `${index}. [${role}] ${text}`;
}

const listCommand: SlashCommand = {
  name: 'list',
  description: 'List the entire current conversation history',
  kind: CommandKind.BUILT_IN,
  action: async (context): Promise<void | MessageActionReturn> => {
    const chat = await context.services.config?.getGeminiClient()?.getChat();
    if (!chat) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No chat client available to list conversation history.',
      };
    }

    const history = chat.getHistory();
    if (!history || history.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'No conversation history found.',
      };
    }

    // Emit one INFO item per entry to leverage InfoMessage's margin spacing
    history.forEach((c, i) => {
      const line = formatHistoryLine(i + 1, c);
      context.ui.addItem({ type: MessageType.INFO, text: line }, Date.now());
    });
  },
};

const listnCommand: SlashCommand = {
  name: 'listn',
  description:
    'List the last N entries of the current conversation. Usage: /conversation listn <n>',
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<void | MessageActionReturn> => {
    const nStr = args.trim();
    const n = Number.parseInt(nStr, 10);
    if (!nStr || Number.isNaN(n) || n <= 0) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Invalid number. Usage: /conversation listn <n>',
      };
    }

    const chat = await context.services.config?.getGeminiClient()?.getChat();
    if (!chat) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No chat client available to list conversation history.',
      };
    }

    const history = chat.getHistory();
    if (!history || history.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'No conversation history found.',
      };
    }

    const startIndex = Math.max(0, history.length - n);
    const last = history.slice(startIndex);

    last.forEach((c, i) => {
      const index = startIndex + i + 1;
      const line = formatHistoryLine(index, c);
      context.ui.addItem({ type: MessageType.INFO, text: line }, Date.now());
    });
  },
};

const deleteCommand: SlashCommand = {
  name: 'delete',
  description:
    'Delete the Nth entry from the current conversation. Usage: /conversation delete <n>',
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<MessageActionReturn> => {
    const nStr = args.trim();
    const n = Number.parseInt(nStr, 10);
    if (!nStr || Number.isNaN(n) || n <= 0) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Invalid number. Usage: /conversation delete <n>',
      };
    }

    const client = context.services.config?.getGeminiClient();
    const chat = await client?.getChat();
    if (!chat) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No chat client available to modify conversation history.',
      };
    }

    const history = chat.getHistory();
    if (n > history.length) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Invalid index. There are only ${history.length} entries in history.`,
      };
    }

    const newHistory = history.filter((_, idx) => idx !== n - 1);
    client!.setHistory(newHistory);

    return {
      type: 'message',
      messageType: 'info',
      content: `Conversation history entry #${n} deleted.`,
    };
  },
};

const deleteSinceCommand: SlashCommand = {
  name: 'delete-since',
  description:
    'Delete entries from index N to the end. Usage: /conversation delete-since <n>',
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<MessageActionReturn> => {
    const nStr = args.trim();
    const n = Number.parseInt(nStr, 10);
    if (!nStr || Number.isNaN(n) || n <= 0) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Invalid number. Usage: /conversation delete-since <n>',
      };
    }

    const client = context.services.config?.getGeminiClient();
    const chat = await client?.getChat();
    if (!chat) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No chat client available to modify conversation history.',
      };
    }

    const history = chat.getHistory();
    if (n > history.length) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Invalid index. There are only ${history.length} entries in history.`,
      };
    }

    const newHistory = history.slice(0, n - 1);
    client!.setHistory(newHistory);

    return {
      type: 'message',
      messageType: 'info',
      content: `Conversation history entries from #${n} to #${history.length} deleted.`,
    };
  },
};

export const conversationCommand: SlashCommand = {
  name: 'conversation',
  description: 'Operate and manage the current conversation history',
  kind: CommandKind.BUILT_IN,
  subCommands: [listCommand, listnCommand, deleteCommand, deleteSinceCommand],
};
