/** Last owner request from a finished turn. Assistant text is not stored. */

export function latestOwnerText(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "user") {
      continue;
    }
    const text = textOf(record.content);
    if (text) {
      return text;
    }
  }
  return null;
}

function textOf(content: unknown): string | null {
  const raw = typeof content === "string" ? content : partsOf(content);
  if (raw == null) {
    return null;
  }
  const text = raw.replace(/\s+/g, " ").trim().slice(0, 240).trim();
  return text.length > 0 ? text : null;
}

function partsOf(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content.map((part) => {
    if (typeof part === "string") {
      return part;
    }
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
      return part.text;
    }
    return "";
  });
  return parts.join(" ");
}
