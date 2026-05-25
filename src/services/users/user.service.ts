import { userRepository, type User } from '../../repositories/user.repository.js';
import { sendText } from '../whatsapp/whatsapp.js';
import type { RegisterProfile } from '../bills/bill.types.js';

function deriveMerchantName(name: string): string {
  return name.trim().slice(0, 25);
}

export async function handleRegistration(
  phone: string,
  profile: RegisterProfile,
): Promise<void> {
  const existing = await userRepository.findByPhone(phone);
  const name = profile.name?.trim();
  const pixKey = profile.pix_key?.trim();

  if (!existing) {
    if (!name) {
      await sendText(
        phone,
        'Pra começar preciso do seu nome. Manda algo tipo "Sou João, pix joao@email.com".',
      );
      return;
    }
    await userRepository.insert({
      phone,
      name,
      pix_key: pixKey ?? '',
      pix_merchant_name: pixKey ? deriveMerchantName(name) : '',
      pix_merchant_city: 'BRASIL',
      created_at: new Date().toISOString(),
    });
    if (!pixKey) {
      await sendText(
        phone,
        `Prazer, ${name}! Agora me manda sua chave PIX (ex: "pix seu@email.com") pra eu poder gerar as cobranças.`,
      );
      return;
    }
    await sendText(
      phone,
      `Tudo certo, ${name}! 🎉 Manda uma conta, ex: "paguei 60 na pizza, divide com Ana e Beto". Quando alguém te pagar, me avisa ("a Ana me pagou").`,
    );
    return;
  }

  // Update de user existente: correção de nome e/ou coleta lazy de PIX.
  const patch: Partial<User> = {};
  if (name) patch.name = name;
  if (pixKey) {
    patch.pix_key = pixKey;
    patch.pix_merchant_name = deriveMerchantName(name ?? existing.name);
  }
  if (Object.keys(patch).length === 0) return;
  await userRepository.update(phone, patch);
  await sendText(
    phone,
    pixKey
      ? 'Chave PIX salva! Agora manda a conta de novo (ex: "paguei 60 na pizza, divide com Ana e Beto").'
      : 'Atualizei seus dados.',
  );
}

export async function requireRegistrationFirst(phone: string): Promise<void> {
  await sendText(
    phone,
    'Olá! Sou o Slice 👋 Antes de dividir contas preciso do seu nome e chave PIX. Manda algo tipo "Sou João, pix joao@email.com".',
  );
}

export async function requirePixFirst(phone: string, name: string): Promise<void> {
  await sendText(
    phone,
    `${name}, antes de criar a conta preciso da sua chave PIX. Responde "pix sua-chave" (ex: "pix joao@email.com").`,
  );
}

export async function notifyUnknown(phone: string, hasUser: boolean): Promise<void> {
  if (!hasUser) {
    await requireRegistrationFirst(phone);
    return;
  }
  await sendText(
    phone,
    'Não entendi 🤔 Pra criar uma conta: "paguei 60 na pizza, divide com Ana e Beto". Pra marcar pago: "a Ana me pagou".',
  );
}
