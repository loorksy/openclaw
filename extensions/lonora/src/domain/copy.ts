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
    "calendar.empty": "No gold-relevant high or medium events are on the calendar in this window.",
    "calendar.unavailable": "No economic calendar is available. Lonora will not invent an event.",
    "plan.insufficient": "Closed candles are not enough to place a protected stop.",
    "plan.noZone": "No supply or demand zone is available, so no plan was prepared.",
    "plan.zoneWeak": "The nearest zones are not tradable, so no plan was prepared.",
    "plan.noTarget": "No structural target clears the distance floor, so no plan was prepared.",
    "plan.invalid": "The zone does not produce a valid stop, so no plan was prepared.",
    "plan.stopBeyond": "Stop sits beyond the structural level",
    "plan.widened": "The distance floor pushed it farther out.",
    "plan.grade": "Zone grade",
    "cases.insufficient": "Closed history is too short to compare with earlier gold moments.",
    "cases.none": "No earlier gold moment is similar enough to count.",
    "cases.counts": "Similar moments are too few for a rate",
    "cases.rate": "Resolved similar moments",
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
    "calendar.empty": "لا أحداث عالية أو متوسطة ذات صلة بالذهب في هذه النافذة.",
    "calendar.unavailable": "التقويم الاقتصادي غير متاح. لن تخترع لونورا حدثاً.",
    "plan.insufficient": "الشموع المغلقة لا تكفي لوضع وقف محمي.",
    "plan.noZone": "لا توجد منطقة عرض أو طلب، لذلك لم تُجهَّز خطة.",
    "plan.zoneWeak": "المناطق القريبة غير قابلة للتداول، لذلك لم تُجهَّز خطة.",
    "plan.noTarget": "لا يوجد هدف هيكلي يجتاز حد المسافة، لذلك لم تُجهَّز خطة.",
    "plan.invalid": "المنطقة لا تنتج وقفاً صالحاً، لذلك لم تُجهَّز خطة.",
    "plan.stopBeyond": "الوقف يقع بعد المستوى الهيكلي",
    "plan.widened": "حد المسافة دفعه أبعد.",
    "plan.grade": "درجة المنطقة",
    "cases.insufficient": "التاريخ المغلق أقصر من أن يُقارن بلحظات ذهب سابقة.",
    "cases.none": "لا توجد لحظة ذهب سابقة قريبة بما يكفي.",
    "cases.counts": "اللحظات المتشابهة أقل من أن تُنتج نسبة",
    "cases.rate": "لحظات متشابهة محسومة",
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
