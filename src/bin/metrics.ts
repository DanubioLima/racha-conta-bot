// Métricas da validação — leitura ESTRITAMENTE read-only do SQLite.
//
// Uso:
//   npm run metrics                  → data/slice.db local
//   npm run metrics -- caminho.db    → outro arquivo (ex: cópia baixada de prod
//                                      via docker cp, com -wal/-shm juntos)
//
// Métrica-mãe da validação: % de usuários com um 2º dia de atividade em até
// 14 dias após o primeiro (atividade = criou conta/dívida/gasto; dias contados
// no calendário de São Paulo).

import Database from 'better-sqlite3';

const databasePath = process.argv[2] ?? process.env.SLICE_DB_PATH ?? 'data/slice.db';
const database = new Database(databasePath, { readonly: true, fileMustExist: true });

// Dia-calendário em São Paulo (UTC-3 fixo desde 2019) a partir de ISO UTC.
function brtDayOf(column: string): string {
  return `date(datetime(${column}, '-3 hours'))`;
}

const sevenDaysAgoISO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

// ---- Usuários ----
const totalUsers = (database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
const newUsersLast7Days = (
  database.prepare('SELECT COUNT(*) AS count FROM users WHERE created_at >= ?').get(sevenDaysAgoISO) as { count: number }
).count;

// ---- Retorno (métrica-mãe) ----
const activityDays = database
  .prepare(
    `SELECT owner_phone, day FROM (
       SELECT owner_phone, ${brtDayOf('created_at')} AS day FROM bills
       UNION
       SELECT owner_phone, ${brtDayOf('spent_at')} AS day FROM expenses
     ) ORDER BY owner_phone, day`,
  )
  .all() as { owner_phone: string; day: string }[];

const daysByUser = new Map<string, string[]>();
for (const row of activityDays) {
  const days = daysByUser.get(row.owner_phone) ?? [];
  days.push(row.day);
  daysByUser.set(row.owner_phone, days);
}

function daysBetween(firstDay: string, laterDay: string): number {
  return (Date.parse(laterDay) - Date.parse(firstDay)) / (24 * 60 * 60 * 1000);
}

const activeUsers = daysByUser.size;
const returnedWithin14Days = [...daysByUser.values()].filter(
  (days) => days.length >= 2 && daysBetween(days[0]!, days[1]!) <= 14,
).length;
const returnRate = activeUsers > 0 ? Math.round((returnedWithin14Days / activeUsers) * 100) : 0;

// ---- Uso por feature ----
const billsByKindAndStatus = database
  .prepare('SELECT kind, status, COUNT(*) AS count FROM bills GROUP BY kind, status ORDER BY kind, status')
  .all() as { kind: string; status: string; count: number }[];

const expensesByCategory = database
  .prepare(
    'SELECT category, COUNT(*) AS count, ROUND(SUM(amount), 2) AS total FROM expenses GROUP BY category ORDER BY count DESC',
  )
  .all() as { category: string; count: number; total: number }[];

const unknownIntentsLast7Days = (
  database.prepare('SELECT COUNT(*) AS count FROM unknown_intents WHERE at >= ?').get(sevenDaysAgoISO) as { count: number }
).count;

// ---- Relatório ----
console.log(`\n📊 Slice — métricas (${databasePath})\n`);
console.log('Usuários');
console.log(`  total: ${totalUsers} · novos (7d): ${newUsersLast7Days} · com alguma atividade: ${activeUsers}`);
console.log('\nRetorno (métrica-mãe da validação)');
console.log(`  2º dia de atividade em ≤14d: ${returnedWithin14Days}/${activeUsers} (${returnRate}%)`);
console.log('\nBills por tipo/status');
for (const row of billsByKindAndStatus) {
  console.log(`  ${row.kind}/${row.status}: ${row.count}`);
}
if (billsByKindAndStatus.length === 0) console.log('  (nenhuma)');
console.log('\nGastos por categoria');
for (const row of expensesByCategory) {
  console.log(`  ${row.category}: ${row.count} (R$ ${row.total})`);
}
if (expensesByCategory.length === 0) console.log('  (nenhum)');
console.log(`\nUnknown intents (7d): ${unknownIntentsLast7Days} — radar de falha de classificação\n`);
