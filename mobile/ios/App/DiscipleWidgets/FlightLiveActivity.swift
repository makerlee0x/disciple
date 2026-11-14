import ActivityKit
import WidgetKit
import SwiftUI

/// The flight on the lock screen and in the Dynamic Island (maker 2026-11-14): ticker, zone, market cap, your bag and its PnL.
/// Gold = up, pink = down (the game's colours). A tap opens the flight in the app.
private let gold = Color(red: 0.95, green: 0.76, blue: 0.31)
private let cream = Color(red: 0.95, green: 0.87, blue: 0.66)
private let green = Color(red: 0.37, green: 0.94, blue: 0.63)
private let pink = Color(red: 1.0, green: 0.50, blue: 0.70)
private let night = Color(red: 0.07, green: 0.07, blue: 0.15)

private func money(_ v: Double, signed: Bool = false) -> String {
    let a = abs(v), s = signed ? (v >= 0 ? "+" : "-") : (v < 0 ? "-" : "")
    if a >= 1_000_000 { return "\(s)$\(String(format: "%.1f", a / 1_000_000))M" }
    if a >= 10_000 { return "\(s)$\(String(format: "%.1f", a / 1_000))K" }
    return "\(s)$\(String(format: a >= 100 ? "%.0f" : "%.2f", a))"
}
private func pct(_ v: Double) -> String { "\(v >= 0 ? "+" : "")\(String(format: abs(v) >= 100 ? "%.0f" : "%.1f", v))%" }
private func openURL(_ path: String) -> URL? { URL(string: "disciple:/" + (path.hasPrefix("/") ? path : "/" + path)) }

struct FlightLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: FlightActivityAttributes.self) { ctx in
            LockScreenFlight(a: ctx.attributes, s: ctx.state)
                .activityBackgroundTint(night)
                .activitySystemActionForegroundColor(cream)
                .widgetURL(openURL(ctx.attributes.path))
        } dynamicIsland: { ctx in
            let s = ctx.state, up = s.pnlUsd >= 0
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ctx.attributes.ticker).font(.headline.weight(.heavy)).foregroundColor(.white)
                        Text(s.zone).font(.caption2.weight(.bold)).foregroundColor(cream)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(money(s.pnlUsd, signed: true)).font(.headline.weight(.heavy)).foregroundColor(up ? green : pink)
                        Text(pct(s.pnlPct)).font(.caption2.weight(.bold)).foregroundColor(up ? green : pink)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Text(s.closed ? "Cashed out" : "Bag \(money(s.bagUsd))").font(.caption.weight(.semibold)).foregroundColor(.white)
                        Spacer()
                        Text("MCAP \(s.mcap)").font(.caption.weight(.semibold)).foregroundColor(cream)
                    }
                }
            } compactLeading: {
                Text(ctx.attributes.ticker).font(.caption.weight(.heavy)).foregroundColor(gold)
            } compactTrailing: {
                Text(pct(s.pnlPct)).font(.caption.weight(.heavy)).foregroundColor(up ? green : pink)
            } minimal: {
                Image(systemName: "airplane.departure").foregroundColor(up ? green : pink)
            }
            .widgetURL(openURL(ctx.attributes.path))
            .keylineTint(gold)
        }
    }
}

private struct LockScreenFlight: View {
    let a: FlightActivityAttributes
    let s: FlightActivityAttributes.ContentState
    var body: some View {
        let up = s.pnlUsd >= 0
        HStack(alignment: .center, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(a.ticker).font(.title3.weight(.heavy)).foregroundColor(.white)
                Text(s.zone).font(.caption.weight(.bold)).foregroundColor(cream)
                Text("MCAP \(s.mcap)").font(.caption2.weight(.semibold)).foregroundColor(.white.opacity(0.7))
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text(money(s.pnlUsd, signed: true)).font(.title2.weight(.heavy)).foregroundColor(up ? green : pink)
                Text(pct(s.pnlPct)).font(.caption.weight(.bold)).foregroundColor(up ? green : pink)
                Text(s.closed ? "Cashed out" : "Bag \(money(s.bagUsd))").font(.caption2.weight(.semibold)).foregroundColor(.white.opacity(0.8))
            }
        }
        .padding(16)
    }
}
