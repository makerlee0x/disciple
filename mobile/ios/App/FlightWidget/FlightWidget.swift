// DISCIPLE Live Activity: your flight on the lock screen and in the Dynamic Island (maker 2026-11-14, option 5).
// Data: Shared/FlightActivity.swift. Tapping it opens the coin in the app (widgetURL → the app's deep link handling).
import ActivityKit
import SwiftUI
import WidgetKit

private let gold = Color(red: 0.949, green: 0.757, blue: 0.306)     // #F2C14E
private let green = Color(red: 0.373, green: 0.941, blue: 0.627)    // #5FF0A0
private let pink = Color(red: 1.0, green: 0.561, blue: 0.741)       // #FF8FBD
private let ink = Color(red: 0.043, green: 0.047, blue: 0.055)      // #0B0C0E

private func money(_ v: Double, sign: Bool = false) -> String {
  let a = abs(v), s = sign ? (v >= 0 ? "+" : "−") : (v < 0 ? "−" : "")
  if a >= 1e9 { return "\(s)$\(String(format: "%.1f", a / 1e9))B" }
  if a >= 1e6 { return "\(s)$\(String(format: "%.1f", a / 1e6))M" }
  if a >= 1e4 { return "\(s)$\(String(format: "%.1f", a / 1e3))K" }
  return "\(s)$\(String(format: a >= 100 ? "%.0f" : "%.2f", a))"
}
private func pct(_ v: Double) -> String { "\(v >= 0 ? "+" : "−")\(String(format: abs(v) >= 100 ? "%.0f" : "%.1f", abs(v)))%" }
private func deepLink(_ path: String) -> URL? { URL(string: "disciple:/" + (path.hasPrefix("/") ? path : "/" + path)) }   // disciple://coin/0x… (lib/native deepLinkPath)

@available(iOS 16.2, *)
struct RocketMark: View {
  var up: Bool
  var body: some View {
    Image(systemName: up ? "arrow.up.forward.circle.fill" : "arrow.down.forward.circle.fill")
      .foregroundStyle(up ? gold : pink)
  }
}

@available(iOS 16.2, *)
struct ZoneBar: View {
  var p: Double
  var body: some View {
    GeometryReader { g in
      ZStack(alignment: .leading) {
        Capsule().fill(Color.white.opacity(0.15))
        Capsule().fill(gold).frame(width: max(6, g.size.width * p))
      }
    }.frame(height: 6)
  }
}

@available(iOS 16.2, *)
struct LockScreenFlight: View {
  let a: FlightAttributes, s: FlightAttributes.ContentState
  var body: some View {
    let up = s.pnlUsd >= 0
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text("DISCIPLE").font(.system(size: 13, weight: .heavy)).kerning(2).foregroundStyle(gold)
        Text("$\(a.ticker)").font(.system(size: 13, weight: .bold)).foregroundStyle(.white.opacity(0.7))
        Spacer()
        Text(s.closed ? "LANDED" : s.zone).font(.system(size: 13, weight: .heavy)).foregroundStyle(.white)
      }
      HStack(alignment: .firstTextBaseline) {
        VStack(alignment: .leading, spacing: 2) {
          Text(s.closed ? "BANKED" : "YOUR BAG").font(.system(size: 11, weight: .bold)).foregroundStyle(.white.opacity(0.6))
          Text(money(s.valueUsd)).font(.system(size: 30, weight: .heavy)).foregroundStyle(.white).monospacedDigit()
        }
        Spacer()
        VStack(alignment: .trailing, spacing: 2) {
          Text(money(s.pnlUsd, sign: true)).font(.system(size: 22, weight: .heavy)).foregroundStyle(up ? green : pink).monospacedDigit()
          Text(pct(s.pnlPct)).font(.system(size: 13, weight: .bold)).foregroundStyle(up ? green : pink).monospacedDigit()
        }
      }
      if !s.closed {
        VStack(alignment: .leading, spacing: 4) {
          ZoneBar(p: s.zoneProgress)
          HStack {
            Text("Altitude \(money(s.mcap))").font(.system(size: 11, weight: .semibold)).foregroundStyle(.white.opacity(0.6))
            Spacer()
            Text("next: \(s.nextZone)").font(.system(size: 11, weight: .semibold)).foregroundStyle(.white.opacity(0.6))
          }
        }
      }
    }
    .padding(16)
    .activityBackgroundTint(ink.opacity(0.92))
    .activitySystemActionForegroundColor(gold)
  }
}

@available(iOS 16.2, *)
struct FlightLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: FlightAttributes.self) { ctx in
      LockScreenFlight(a: ctx.attributes, s: ctx.state).widgetURL(deepLink(ctx.attributes.url))
    } dynamicIsland: { ctx in
      let s = ctx.state, up = s.pnlUsd >= 0
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          VStack(alignment: .leading, spacing: 2) {
            Text("$\(ctx.attributes.ticker)").font(.system(size: 13, weight: .heavy)).foregroundStyle(gold)
            Text(s.closed ? "LANDED" : s.zone).font(.system(size: 12, weight: .bold)).foregroundStyle(.white.opacity(0.75))
          }
        }
        DynamicIslandExpandedRegion(.trailing) {
          VStack(alignment: .trailing, spacing: 2) {
            Text(money(s.pnlUsd, sign: true)).font(.system(size: 17, weight: .heavy)).foregroundStyle(up ? green : pink).monospacedDigit()
            Text(pct(s.pnlPct)).font(.system(size: 12, weight: .bold)).foregroundStyle(up ? green : pink)
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(spacing: 6) {
            HStack {
              Text("Bag \(money(s.valueUsd))").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
              Spacer()
              Text("Altitude \(money(s.mcap))").font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.6))
            }
            if !s.closed { ZoneBar(p: s.zoneProgress) }
          }
        }
      } compactLeading: {
        HStack(spacing: 4) { RocketMark(up: up); Text(ctx.attributes.ticker).font(.system(size: 12, weight: .heavy)).foregroundStyle(gold) }
      } compactTrailing: {
        Text(pct(s.pnlPct)).font(.system(size: 12, weight: .heavy)).foregroundStyle(up ? green : pink).monospacedDigit()
      } minimal: {
        RocketMark(up: up)
      }
      .widgetURL(deepLink(ctx.attributes.url))
      .keylineTint(gold)
    }
  }
}

@main
struct FlightWidgetBundle: WidgetBundle {
  var body: some Widget {
    if #available(iOS 16.2, *) { FlightLiveActivity() }
  }
}
