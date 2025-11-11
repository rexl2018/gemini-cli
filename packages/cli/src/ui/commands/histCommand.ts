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

const MAX_HISTORY_LINE_LENGTH = 2000;

function formatHistoryLine(index: number, content: Content): string {
  const role = content.role ?? 'model';
  const text = contentText(content);
  const line = `${index}. [${role}] ${text}`;
  if (line.length <= MAX_HISTORY_LINE_LENGTH) {
    return line;
  }
  return `${line.slice(0, MAX_HISTORY_LINE_LENGTH - 1)}…`;
}

const listallCommand: SlashCommand = {
  name: 'listall',
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

const llCommand: SlashCommand = {
  name: 'll',
  description:
    'List the last N entries of the current conversation. Usage: /hist ll <n> (ll means "list last")',
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<void | MessageActionReturn> => {
    const nStr = args.trim();
    const n = Number.parseInt(nStr, 10);
    if (!nStr || Number.isNaN(n) || n <= 0) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Invalid number. Usage: /hist ll <n>',
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
  name: 'del',
  description:
    'Delete the Nth entry from the current conversation. Usage: /hist del <n>',
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<MessageActionReturn> => {
    const nStr = args.trim();
    const n = Number.parseInt(nStr, 10);
    if (!nStr || Number.isNaN(n) || n <= 0) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Invalid number. Usage: /hist del <n>',
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

const deleteAfterCommand: SlashCommand = {
  name: 'del-after',
  description:
    'Delete entries from index N to the end (inclusive). Usage: /hist del-after <n>',
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<MessageActionReturn> => {
    const nStr = args.trim();
    const n = Number.parseInt(nStr, 10);
    if (!nStr || Number.isNaN(n) || n <= 0) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Invalid number. Usage: /hist del-after <n>',
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

const deleteLastCommand: SlashCommand = {
  name: 'del-last',
  description: 'Delete the last N entries. Usage: /hist del-last <n>',
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<MessageActionReturn> => {
    const nStr = args.trim();
    const n = Number.parseInt(nStr, 10);
    if (!nStr || Number.isNaN(n) || n <= 0) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Invalid number. Usage: /hist del-last <n>',
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

    const newHistory = history.slice(0, history.length - n);
    client!.setHistory(newHistory);

    return {
      type: 'message',
      messageType: 'info',
      content: `Last ${n} entries deleted from conversation history.`,
    };
  },
};

const deleteRangeCommand: SlashCommand = {
  name: 'del-range',
  description:
    'Delete entries from index M to N (inclusive). Usage: /hist del-range <m>,<n>',
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<MessageActionReturn> => {
    const parts = args
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (parts.length !== 2) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Invalid range. Usage: /hist del-range <m>,<n>',
      };
    }

    const [startStr, endStr] = parts;
    const start = Number.parseInt(startStr, 10);
    const end = Number.parseInt(endStr, 10);

    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start <= 0 ||
      end <= 0 ||
      start > end
    ) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Invalid range. Usage: /hist del-range <m>,<n>',
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
    if (end > history.length) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Invalid index. There are only ${history.length} entries in history.`,
      };
    }

    const before = history.slice(0, start - 1);
    const after = history.slice(end);
    const newHistory = before.concat(after);
    client!.setHistory(newHistory);

    return {
      type: 'message',
      messageType: 'info',
      content: `Conversation history entries from #${start} to #${end} deleted.`,
    };
  },
};

const deleteBeforeCommand: SlashCommand = {
  name: 'del-before',
  description:
    'Delete entries from the beginning up to index N (inclusive). Usage: /hist del-before <n>',
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<MessageActionReturn> => {
    const nStr = args.trim();
    const n = Number.parseInt(nStr, 10);
    if (!nStr || Number.isNaN(n) || n <= 0) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Invalid number. Usage: /hist del-before <n>',
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

    // Remove entries from 1..n (inclusive) => keep entries from index n onward
    const newHistory = history.slice(n);
    client!.setHistory(newHistory);

    return {
      type: 'message',
      messageType: 'info',
      content: `Conversation history entries from #1 to #${n} deleted.`,
    };
  },
};

const laCommand: SlashCommand = {
  name: 'la',
  description:
    'List entries around the Nth entry (n-2 to n+2). Usage: /hist la <n> (la means "list around")',
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<void | MessageActionReturn> => {
    const nStr = args.trim();
    const n = Number.parseInt(nStr, 10);
    if (!nStr || Number.isNaN(n) || n <= 0) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Invalid number. Usage: /hist la <n>',
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

    if (n > history.length) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Invalid index. There are only ${history.length} entries in history.`,
      };
    }

    // Show entries from n-3 to n+1 (array indices are 0-based)
    // This corresponds to user-visible indices n-2 to n+2
    const startIndex = Math.max(0, n - 3);
    const endIndex = Math.min(history.length, n + 1);

    const around = history.slice(startIndex, endIndex + 1);

    around.forEach((c, i) => {
      const index = startIndex + i + 1;
      const line = formatHistoryLine(index, c);
      context.ui.addItem({ type: MessageType.INFO, text: line }, Date.now());
    });
  },
};

export const histCommand: SlashCommand = {
  name: 'hist',
  description: 'Operate and manage the current conversation history',
  kind: CommandKind.BUILT_IN,
  subCommands: [
    listallCommand,
    llCommand,
    laCommand,
    deleteCommand,
    deleteAfterCommand,
    deleteLastCommand,
    deleteRangeCommand,
    deleteBeforeCommand,
  ],
};
