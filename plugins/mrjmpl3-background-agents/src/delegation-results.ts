import type { Part, TextPart } from '@opencode-ai/sdk';

import type { AssistantSessionMessageItem, Delegation, OpencodeClient, SessionMessageItem } from './types.ts';

type DebugLog = (message: string) => Promise<void>;

function getDelegationLabel(delegation: Delegation): string {
  return delegation.title || delegation.description || delegation.id;
}

function isAssistantMessage(message: SessionMessageItem): message is AssistantSessionMessageItem {
  return message.info.role === 'assistant';
}

function isTextPart(part: Part): part is TextPart {
  return part.type === 'text';
}

export async function getDelegationResult(
  client: OpencodeClient,
  delegation: Delegation,
  debugLog: DebugLog,
): Promise<string> {
  try {
    const delegationLabel = getDelegationLabel(delegation);
    const messages = await client.session.messages({
      path: { id: delegation.sessionID },
    });

    const messageData = messages.data as SessionMessageItem[] | undefined;

    if (!messageData || messageData.length === 0) {
      await debugLog(`getResult: No messages found for session ${delegation.sessionID}`);
      return `Delegation "${delegationLabel}" completed but produced no output.`;
    }

    await debugLog(
      `getResult: Found ${messageData.length} messages. Roles: ${messageData.map((message) => message.info.role).join(', ')}`,
    );

    const assistantMessages = messageData.filter(isAssistantMessage);

    if (assistantMessages.length === 0) {
      await debugLog(
        `getResult: No assistant messages found in ${JSON.stringify(
          messageData.map((message) => ({ role: message.info.role, keys: Object.keys(message) })),
        )}`,
      );
      return `Delegation "${delegationLabel}" completed but produced no assistant response.`;
    }

    const lastMessage = assistantMessages[assistantMessages.length - 1];
    const textParts = lastMessage.parts.filter(isTextPart);

    if (textParts.length === 0) {
      await debugLog(`getResult: No text parts found in message: ${JSON.stringify(lastMessage)}`);
      return `Delegation "${delegationLabel}" completed but produced no text content.`;
    }

    return textParts.map((part) => part.text).join('\n');
  } catch (error) {
    await debugLog(`getResult error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    const delegationLabel = getDelegationLabel(delegation);

    return `Delegation "${delegationLabel}" completed but result could not be retrieved: ${
      error instanceof Error ? error.message : 'Unknown error'
    }`;
  }
}
