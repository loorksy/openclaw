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
    "plan.targets": "Structural targets",
    "plan.spreadUnread": "The spread was not read, so this reward is not net of cost.",
    "plan.spreadNet": "Net reward after spread",
    "plan.spreadWeak": "The first target does not pay the spread.",
    "plan.htfUnknown": "The higher timeframe was not read.",
    "plan.htfConflict": "The higher timeframe conflicts with this direction.",
    "plan.htfAligned": "The higher timeframe agrees with this direction.",
    "plan.pathBroken": "Price already broke the entry zone, so no plan was prepared.",
    "plan.pathUnlikely":
      "Price is moving away from the pending zone. This is not a trade in the other direction.",
    "plan.pathNeutral":
      "The idea waits for price to return to the zone. The path is not a trade the other way.",
    "cases.insufficient": "Closed history is too short to compare with earlier gold moments.",
    "cases.none": "No earlier gold moment is similar enough to count.",
    "cases.counts": "Similar moments are too few for a rate",
    "cases.rate": "Resolved similar moments",
    "headlines.unavailable":
      "Gold headlines are not available. Lonora will not invent a quiet tape.",
    "headlines.empty": "No gold-relevant headlines are in this window.",
    "memory.empty": "No gold memory is stored yet.",
    "memory.lead": "Gold memory.",
    "memory.scenario": "Scenario:",
    "memory.lessons": "Lessons:",
    "memory.tasks": "Responsibilities:",
    "pattern.unclassified": "The swing range is not classified yet.",
    "pattern.starting": "A swing range is starting.",
    "pattern.forming": "A swing range is forming.",
    "pattern.near": "A swing range is near completion.",
    "pattern.completed": "A close moved beyond the swing range. Confirmation is still open.",
    "pattern.confirmed": "A later close confirmed the move beyond the swing range.",
    "pattern.failed": "The swing range failed.",
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
    "plan.targets": "أهداف هيكلية",
    "plan.spreadUnread": "السبريد لم يُقرأ، لذلك هذه المكافأة ليست صافية من التكلفة.",
    "plan.spreadNet": "المكافأة الصافية بعد السبريد",
    "plan.spreadWeak": "الهدف الأول لا يغطي السبريد.",
    "plan.htfUnknown": "الإطار الزمني الأعلى لم يُقرأ.",
    "plan.htfConflict": "الإطار الزمني الأعلى يتعارض مع هذا الاتجاه.",
    "plan.htfAligned": "الإطار الزمني الأعلى يوافق هذا الاتجاه.",
    "plan.pathBroken": "السعر اخترق منطقة الدخول، لذلك لم تُجهَّز خطة.",
    "plan.pathUnlikely": "السعر يبتعد عن المنطقة المعلقة. هذا ليس صفقة في الاتجاه المعاكس.",
    "plan.pathNeutral": "الفكرة تنتظر عودة السعر إلى المنطقة. المسار ليس صفقة في الاتجاه المعاكس.",
    "cases.insufficient": "التاريخ المغلق أقصر من أن يُقارن بلحظات ذهب سابقة.",
    "cases.none": "لا توجد لحظة ذهب سابقة قريبة بما يكفي.",
    "cases.counts": "اللحظات المتشابهة أقل من أن تُنتج نسبة",
    "cases.rate": "لحظات متشابهة محسومة",
    "headlines.unavailable": "عناوين الذهب غير متاحة. لن تخترع لونورا شريطاً هادئاً.",
    "headlines.empty": "لا عناوين ذات صلة بالذهب في هذه النافذة.",
    "memory.empty": "لا ذاكرة ذهب مخزّنة بعد.",
    "memory.lead": "ذاكرة الذهب.",
    "memory.scenario": "السيناريو:",
    "memory.lessons": "الدروس:",
    "memory.tasks": "المسؤوليات:",
    "pattern.unclassified": "نطاق التأرجح لم يُصنَّف بعد.",
    "pattern.starting": "نطاق تأرجح بدأ يتكوّن.",
    "pattern.forming": "نطاق تأرجح قيد التكوّن.",
    "pattern.near": "نطاق التأرجح قارب الاكتمال.",
    "pattern.completed": "إغلاق تجاوز نطاق التأرجح. التأكيد ما زال مفتوحاً.",
    "pattern.confirmed": "إغلاق لاحق أكّد الحركة خارج نطاق التأرجح.",
    "pattern.failed": "فشل نطاق التأرجح.",
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
