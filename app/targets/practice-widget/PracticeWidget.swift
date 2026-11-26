// The Practice home-screen widget on iOS: cards left today, the streak and the
// week, from the counts-only summary the app saves to the shared App Group
// (src/widget/index.js). Tapping it opens hiro://practice.
//
// The wording mirrors widgetView in src/practice.js, so the Android and iOS
// widgets say the same thing: a summary from an earlier day reads "New cards
// today", and the streak and the week's count are only claimed while true.

import SwiftUI
import WidgetKit

let appGroup = "group.com.cessleigh.hiro"
let summaryKey = "hiro.practiceWidget.v1"

struct PracticeSummary: Decodable {
  let day: String
  let left: Int
  let done: Int
  let total: Int
  let streak: Int
  let practisedToday: Bool
  let daysThisWeek: Int
  let weeklyGoalDays: Int
}

struct PracticeView {
  let headline: String
  let detail: String
}

private func dayString(_ date: Date) -> String {
  let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
  return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
}

private func parseDay(_ s: String) -> Date? {
  let parts = s.split(separator: "-").compactMap { Int($0) }
  guard parts.count == 3 else { return nil }
  return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
}

private func mondayOf(_ date: Date) -> String {
  let cal = Calendar.current
  let weekday = cal.component(.weekday, from: date) // 1 = Sunday
  let back = (weekday + 5) % 7
  return dayString(cal.date(byAdding: .day, value: -back, to: date) ?? date)
}

private func plural(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }

func practiceView(_ summary: PracticeSummary?, now: Date) -> PracticeView {
  let fallback = PracticeView(headline: "Daily interview practice", detail: "Open Hiro to see today’s cards.")
  guard let s = summary, let summaryDate = parseDay(s.day) else { return fallback }
  let today = dayString(now)
  let goal = s.weeklyGoalDays > 0 ? s.weeklyGoalDays : 4
  if s.day == today {
    let headline = s.left > 0 ? "\(plural(s.left, "card")) left today" : "Done for today ✓"
    let week = "\(s.daysThisWeek) of \(goal) days this week"
    return PracticeView(headline: headline, detail: s.streak > 0 ? "\(s.streak)-day streak · \(week)" : week)
  }
  if s.day > today { return fallback }
  let yesterday = dayString(Calendar.current.date(byAdding: .day, value: -1, to: now) ?? now)
  let alive = s.practisedToday && s.day == yesterday && s.streak > 0
  let sameWeek = mondayOf(summaryDate) == mondayOf(now)
  let week = "\(sameWeek ? s.daysThisWeek : 0) of \(goal) days this week"
  return PracticeView(headline: "New cards today", detail: alive ? "Keep your \(s.streak)-day streak · \(week)" : week)
}

struct PracticeEntry: TimelineEntry {
  let date: Date
  let view: PracticeView
}

struct PracticeProvider: TimelineProvider {
  private func readSummary() -> PracticeSummary? {
    guard let raw = UserDefaults(suiteName: appGroup)?.string(forKey: summaryKey),
          let data = raw.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(PracticeSummary.self, from: data)
  }

  func placeholder(in context: Context) -> PracticeEntry {
    PracticeEntry(date: Date(), view: PracticeView(headline: "3 cards left today", detail: "5-day streak · 3 of 4 days this week"))
  }

  func getSnapshot(in context: Context, completion: @escaping (PracticeEntry) -> Void) {
    completion(PracticeEntry(date: Date(), view: practiceView(readSummary(), now: Date())))
  }

  // Now, and again just after midnight, when the wording changes with the day.
  // The app also asks for a reload whenever the day's counts change.
  func getTimeline(in context: Context, completion: @escaping (Timeline<PracticeEntry>) -> Void) {
    let now = Date()
    let summary = readSummary()
    let midnight = Calendar.current.startOfDay(for: Calendar.current.date(byAdding: .day, value: 1, to: now) ?? now)
    let entries = [
      PracticeEntry(date: now, view: practiceView(summary, now: now)),
      PracticeEntry(date: midnight.addingTimeInterval(60), view: practiceView(summary, now: midnight.addingTimeInterval(60))),
    ]
    completion(Timeline(entries: entries, policy: .after(midnight.addingTimeInterval(60))))
  }
}

struct PracticeWidgetView: View {
  let entry: PracticeEntry

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Hiro · Practice")
        .font(.caption)
        .fontWeight(.semibold)
        .foregroundStyle(Color("$accent"))
      Text(entry.view.headline)
        .font(.title3)
        .fontWeight(.bold)
        .lineLimit(2)
        .minimumScaleFactor(0.8)
      Spacer(minLength: 0)
      Text(entry.view.detail)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(2)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .containerBackground(Color("$widgetBackground"), for: .widget)
    .widgetURL(URL(string: "hiro://practice"))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Hiro practice. \(entry.view.headline). \(entry.view.detail)")
  }
}

struct PracticeWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "Practice", provider: PracticeProvider()) { entry in
      PracticeWidgetView(entry: entry)
    }
    .configurationDisplayName("Hiro practice")
    .description("Cards left today and your practice streak.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}
