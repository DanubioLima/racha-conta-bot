import { userRepository, type User } from '../../repositories/user.repository.js';
import { sendText } from '../whatsapp/whatsapp.js';
import {
  askForName,
  welcomeNeedPix,
  welcomeReady,
  pixSaved,
  profileUpdated,
} from '../messaging/voice.js';
import type { RegisterProfile } from '../bills/bill.types.js';

function deriveMerchantName(name: string): string {
  return name.trim().slice(0, 25);
}

interface RegistrationOptions {
  // Quando true, NÃO envia mensagem nenhuma — só persiste. Usado no intent misto
  // (registrar + criar conta na mesma mensagem), onde quem responde é o dispatcher.
  continueToBill?: boolean;
}

export async function handleRegistration(
  phone: string,
  profile: RegisterProfile,
  options: RegistrationOptions = {},
): Promise<string> {
  const silent = options.continueToBill === true;
  const existing = await userRepository.findByPhone(phone);
  const name = profile.name?.trim();
  const pixKey = profile.pix_key?.trim();

  if (!existing) {
    if (!name) {
      const message = askForName();
      if (!silent) await sendText(phone, message);
      return silent ? '' : message;
    }
    await userRepository.insert({
      phone,
      name,
      pix_key: pixKey ?? '',
      pix_merchant_name: pixKey ? deriveMerchantName(name) : '',
      pix_merchant_city: 'BRASIL',
      created_at: new Date().toISOString(),
    });
    const message = pixKey ? welcomeReady(name) : welcomeNeedPix(name);
    if (!silent) await sendText(phone, message);
    return silent ? '' : message;
  }

  // Update de user existente: correção de nome e/ou coleta lazy de PIX.
  const patch: Partial<User> = {};
  if (name) patch.name = name;
  if (pixKey) {
    patch.pix_key = pixKey;
    patch.pix_merchant_name = deriveMerchantName(name ?? existing.name);
  }
  if (Object.keys(patch).length === 0) return '';
  await userRepository.update(phone, patch);
  const message = pixKey ? pixSaved() : profileUpdated();
  if (!silent) await sendText(phone, message);
  return silent ? '' : message;
}
