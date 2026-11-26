export type SeasonLedgerEntry = {
  originalRegularPlayerId: string;
  substitutePlayerId: string;
  amountCents: number;
};

export type SeasonSettlement = {
  debtorId: string;
  creditorId: string;
  amountCents: number;
};

export type SeasonLedgerRecord = SeasonLedgerEntry & {
  id: string;
  gameDate: string;
  fillMethod: "ping" | "claim";
  wasFreeClaim: boolean;
  originalRegularPlayerName: string;
  substitutePlayerName: string;
};

export type SeasonSettlementPayment = SeasonSettlement & {
  debtorName: string;
  creditorName: string;
  isPaid: boolean;
  paidAt: string | null;
};

function addBalance(balances: Map<string, number>, userId: string, delta: number) {
  const balance = (balances.get(userId) ?? 0) + delta;
  if (!Number.isSafeInteger(balance)) {
    throw new Error("Season balances exceed the supported integer range.");
  }
  balances.set(userId, balance);
}

function compareIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function calculateSeasonSettlements(
  ledgerEntries: SeasonLedgerEntry[],
): SeasonSettlement[] {
  const balances = new Map<string, number>();

  for (const entry of ledgerEntries) {
    if (!Number.isSafeInteger(entry.amountCents) || entry.amountCents < 0) {
      throw new Error("Season ledger amounts must be non-negative integer cents.");
    }
    addBalance(balances, entry.originalRegularPlayerId, entry.amountCents);
    addBalance(balances, entry.substitutePlayerId, -entry.amountCents);
  }

  const debtors = [...balances]
    .filter(([, balance]) => balance < 0)
    .map(([id, balance]) => ({ id, amount: -balance }))
    .sort((left, right) => right.amount - left.amount || compareIds(left.id, right.id));
  const creditors = [...balances]
    .filter(([, balance]) => balance > 0)
    .map(([id, balance]) => ({ id, amount: balance }))
    .sort((left, right) => right.amount - left.amount || compareIds(left.id, right.id));

  const settlements: SeasonSettlement[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amountCents = Math.min(debtor.amount, creditor.amount);
    settlements.push({
      debtorId: debtor.id,
      creditorId: creditor.id,
      amountCents,
    });
    debtor.amount -= amountCents;
    creditor.amount -= amountCents;
    if (debtor.amount === 0) debtorIndex += 1;
    if (creditor.amount === 0) creditorIndex += 1;
  }

  return settlements;
}

export function calculateSeasonNetBalance(
  userId: string,
  ledgerEntries: SeasonLedgerEntry[],
) {
  const balances = new Map<string, number>();
  for (const entry of ledgerEntries) {
    if (!Number.isSafeInteger(entry.amountCents) || entry.amountCents < 0) {
      throw new Error("Season ledger amounts must be non-negative integer cents.");
    }
    addBalance(balances, entry.originalRegularPlayerId, entry.amountCents);
    addBalance(balances, entry.substitutePlayerId, -entry.amountCents);
  }
  return balances.get(userId) ?? 0;
}
