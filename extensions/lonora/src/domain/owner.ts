export type OwnerLanguage = "en" | "ar";

export interface OwnerRecord {
  id: string;
  label: string;
  language: OwnerLanguage;
  telegramChatId: string | null;
  source: "explicit" | "migration" | "local-gateway";
}

export class OwnerSelectionRequired extends Error {
  readonly code = "OWNER_SELECTION_REQUIRED";
  readonly candidateIds: string[];
  constructor(candidateIds: string[]) {
    super(
      `Multiple owner candidates (${candidateIds.join(", ")}). Pass an explicit owner id. Lonora will not guess.`,
    );
    this.name = "OwnerSelectionRequired";
    this.candidateIds = candidateIds;
  }
}

export function resolveOwnerCandidate(
  candidates: { id: string }[],
  explicitId?: string,
): { id: string } {
  if (candidates.length === 0) {
    throw new Error("No owner candidate was supplied.");
  }
  if (explicitId) {
    const match = candidates.find((candidate) => candidate.id === explicitId);
    if (!match) {
      throw new OwnerSelectionRequired(candidates.map((candidate) => candidate.id));
    }
    return match;
  }
  if (candidates.length === 1) {
    return candidates[0]!;
  }
  throw new OwnerSelectionRequired(candidates.map((candidate) => candidate.id));
}

export function bindTelegram(
  owner: OwnerRecord,
  chatId: string,
): { ok: true; owner: OwnerRecord } | { ok: false; code: "telegram_already_bound" } {
  if (owner.telegramChatId && owner.telegramChatId !== chatId) {
    return { ok: false, code: "telegram_already_bound" };
  }
  return { ok: true, owner: { ...owner, telegramChatId: chatId } };
}
