import { sendText, sendTemplate, type TemplateBodyArgs } from './cloudapi.client.js';
import { isWindowOpen } from './window.js';
import { env } from '../../config/env.js';

// Public surface preservada pra callers existentes:
// - notifyUser(text)        — manda texto livre se a janela está aberta;
//                             erro descritivo se fechada (caller deve usar template).
// - notifyUserViaTemplate   — manda template aprovado pelo Meta.
// - notifyUserImage         — stub; image não usado no MVP atual (dormente desde PR #2).
// - wasSentByBot            — stub; Cloud API não entrega echoes do bot pelo webhook.

export class WindowClosedError extends Error {
  constructor(userNumber: string) {
    super(`24h window closed for ${userNumber} — use notifyUserViaTemplate with an approved template`);
    this.name = 'WindowClosedError';
  }
}

export async function notifyUser(text: string): Promise<void> {
  const userNumber = env.userWhatsappNumber;
  const open = await isWindowOpen(userNumber);
  if (!open) {
    throw new WindowClosedError(userNumber);
  }
  await sendText(userNumber, text);
}

export async function notifyUserViaTemplate(args: TemplateBodyArgs): Promise<void> {
  await sendTemplate(env.userWhatsappNumber, args);
}

// Stubs preservados pra calling code existente continuar a tipcheckar.
// Image não é usado pós-PR #2; webhook (Task 6) deixa de chamar wasSentByBot.

export async function notifyUserImage(_base64: string, _caption?: string): Promise<void> {
  throw new Error('notifyUserImage não implementado no path Cloud API — uso reservado pra futuro');
}

export function wasSentByBot(_id?: string | null, _text?: string | null): boolean {
  return false;
}
