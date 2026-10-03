import type { OwnerLanguage } from "./owner.js";

const COPY = {
  en: {
    "session.open": "Gold is open.",
    "session.closed_saturday": "Gold is closed for the weekend.",
    "session.closed_friday": "Gold is closed after the New York Friday finish.",
    "session.closed_sunday": "Gold has not opened yet this week.",
    "session.maintenance_break": "Gold is in the daily maintenance break.",
    "status.running": "Lonora is running.",
    "tasks.paused": "Paused.",
    "tasks.resumed": "Resumed.",
    "tasks.cancelled": "Cancelled.",
    "notify.unchanged": "No meaningful gold change.",
    "trade.blocked": "Lonora will not place that trade. Only you can confirm an order.",
  },
  ar: {
    "session.open": "سوق الذهب مفتوح.",
    "session.closed_saturday": "الذهب مغلق لعطلة نهاية الأسبوع.",
    "session.closed_friday": "الذهب مغلق بعد إغلاق جمعة نيويورك.",
    "session.closed_sunday": "الذهب لم يفتح بعد هذا الأسبوع.",
    "session.maintenance_break": "الذهب في استراحة الصيانة اليومية.",
    "status.running": "لونورا تعمل.",
    "tasks.paused": "تم الإيقاف المؤقت.",
    "tasks.resumed": "استؤنفت المهمة.",
    "tasks.cancelled": "أُلغيت المهمة.",
    "notify.unchanged": "لا تغيير مهم في الذهب.",
    "trade.blocked": "لونورا لن تنفّذ هذه الصفقة. التأكيد اليدوي لك وحدك.",
  },
} as const;

export type CopyKey = keyof (typeof COPY)["en"];

export function copy(language: OwnerLanguage, key: CopyKey): string {
  return COPY[language][key] ?? COPY.en[key];
}

export function marketReasonCopy(
  language: OwnerLanguage,
  reason: "open" | "saturday" | "friday_close" | "sunday" | "maintenance",
): string {
  switch (reason) {
    case "open":
      return copy(language, "session.open");
    case "saturday":
      return copy(language, "session.closed_saturday");
    case "friday_close":
      return copy(language, "session.closed_friday");
    case "sunday":
      return copy(language, "session.closed_sunday");
    case "maintenance":
      return copy(language, "session.maintenance_break");
  }
}
