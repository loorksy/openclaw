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
    "notify.telegramMissing": "Telegram is not bound, so this notice stayed here.",
    "notify.deliveryFailed": "Telegram did not accept the notice.",
    "tasks.waitingClosed": "Market is closed. Waiting for the next open.",
    "tasks.waiting": "Still waiting. Nothing in this check matched the instruction.",
    "tasks.matched": "Matched",
    "tasks.scheduled": "Scheduled",
    "tasks.scheduleRejected":
      "The scheduler did not accept this briefing. The monitor will still check it.",
    "trade.blocked": "Lonora will not place that trade. Only you can confirm an order.",
    "recommendations.unreadable":
      "The stored activation rule could not be read, so this plan will not fill.",
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
    "notify.telegramMissing": "تيليجرام غير مربوط، فبقي التنبيه هنا.",
    "notify.deliveryFailed": "تيليجرام لم يقبل التنبيه.",
    "tasks.waitingClosed": "السوق مغلق. الانتظار حتى الفتح التالي.",
    "tasks.waiting": "ما زال الانتظار. هذا الفحص لا يطابق التعليمات.",
    "tasks.matched": "تطابق",
    "tasks.scheduled": "مجدول",
    "tasks.scheduleRejected": "المجدول لم يقبل الإحاطة. المراقبة ستستمر في فحصها.",
    "trade.blocked": "لونورا لن تنفّذ هذه الصفقة. التأكيد اليدوي لك وحدك.",
    "recommendations.unreadable": "تعذر قراءة شرط التفعيل المخزّن، لذلك لن تُملأ هذه الخطة.",
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
