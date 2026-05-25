import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { userRepository } from '../repositories/user.repository.js';
import type { Bill } from '../services/bills/bill.types.js';

async function main(): Promise<void> {
  const phone = env.userWhatsappNumber.replace(/\D/g, '');

  const existing = await userRepository.findByPhone(phone);
  if (!existing) {
    await userRepository.insert({
      phone,
      name: env.pixMerchantName,
      pix_key: env.pixKey,
      pix_merchant_name: env.pixMerchantName.slice(0, 25),
      pix_merchant_city: env.pixMerchantCity,
      created_at: new Date().toISOString(),
    });
    console.log('[seed] created Danubio user', phone);
  } else {
    console.log('[seed] Danubio user already exists', phone);
  }

  const dbPath = path.resolve('data/db.json');
  const db = JSON.parse(await readFile(dbPath, 'utf8')) as { bills: Bill[] };
  let changed = 0;
  for (const bill of db.bills) {
    if (!bill.owner_phone) {
      bill.owner_phone = phone;
      changed++;
    }
  }
  if (changed > 0) {
    await writeFile(dbPath, JSON.stringify(db, null, 2), 'utf8');
    console.log(`[seed] backfilled owner_phone on ${changed} bill(s)`);
  } else {
    console.log('[seed] no bills needed backfill');
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
