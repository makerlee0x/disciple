// Native extras for the DISCIPLE app shell (maker 2026-11-14, phone flight upgrades):
//  - DiscipleHaptics: a continuous Core Haptics "engine rumble" driven by the flight's thrust, plus richer one-shot patterns
//  - LiveFlight: the flight on the lock screen and in the Dynamic Island (ActivityKit), see Shared/FlightActivity.swift
// Both are reached from the site through window.Capacitor.Plugins (web/lib/native.ts); in a browser they simply don't exist.
import UIKit
import Capacitor
import CoreHaptics
#if canImport(ActivityKit)
import ActivityKit
#endif

/// The storyboard's view controller (Main.storyboard customClass): Capacitor's bridge, plus our two local plugins.
class MainViewController: CAPBridgeViewController {
  override open func capacitorDidLoad() {
    bridge?.registerPluginInstance(DiscipleHapticsPlugin())
    bridge?.registerPluginInstance(LiveFlightPlugin())
  }
}

// MARK: - Haptics

@objc(DiscipleHapticsPlugin)
public class DiscipleHapticsPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "DiscipleHapticsPlugin"
  public let jsName = "DiscipleHaptics"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "supported", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "rumble", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
  ]
  private var engine: CHHapticEngine?
  private var loop: CHHapticAdvancedPatternPlayer?
  private let ok = CHHapticEngine.capabilitiesForHardware().supportsHaptics

  private func ready() -> CHHapticEngine? {
    guard ok else { return nil }
    if let e = engine { return e }
    do {
      let e = try CHHapticEngine()
      e.isAutoShutdownEnabled = true
      e.playsHapticsOnly = true
      e.resetHandler = { [weak self] in self?.loop = nil; try? self?.engine?.start() }
      e.stoppedHandler = { [weak self] _ in self?.loop = nil }
      try e.start()
      engine = e
      return e
    } catch { return nil }
  }

  @objc func supported(_ call: CAPPluginCall) { call.resolve(["supported": ok]) }

  /// { intensity 0..1, sharpness 0..1 }: starts the looping rumble if needed, then sets its level (0 intensity = silent).
  @objc func rumble(_ call: CAPPluginCall) {
    let i = Float(max(0, min(1, call.getDouble("intensity") ?? 0))), s = Float(max(0, min(1, call.getDouble("sharpness") ?? 0.3)))
    DispatchQueue.main.async {
      guard let e = self.ready() else { call.resolve(["supported": false]); return }
      do {
        if self.loop == nil {
          let ev = CHHapticEvent(eventType: .hapticContinuous, parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: 1),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.3),
          ], relativeTime: 0, duration: 30)
          let p = try e.makeAdvancedPlayer(with: try CHHapticPattern(events: [ev], parameters: []))
          p.loopEnabled = true
          try p.start(atTime: CHHapticTimeImmediate)
          self.loop = p
        }
        try self.loop?.sendParameters([
          CHHapticDynamicParameter(parameterID: .hapticIntensityControl, value: i, relativeTime: 0),
          CHHapticDynamicParameter(parameterID: .hapticSharpnessControl, value: s - 0.3, relativeTime: 0),
        ], atTime: CHHapticTimeImmediate)
        call.resolve(["supported": true])
      } catch { self.loop = nil; call.resolve(["supported": true, "error": error.localizedDescription]) }
    }
  }

  @objc func stop(_ call: CAPPluginCall) {
    DispatchQueue.main.async { try? self.loop?.stop(atTime: CHHapticTimeImmediate); self.loop = nil; call.resolve() }
  }

  /// { pattern: "bomb" | "zone" | "orbit" | "trick" | "fill" | "stylefill" }: a one-shot over the rumble.
  @objc func play(_ call: CAPPluginCall) {
    let name = call.getString("pattern") ?? ""
    DispatchQueue.main.async {
      guard let e = self.ready(), let events = Self.pattern(name) else { call.resolve(["supported": self.ok]); return }
      do { try e.makePlayer(with: try CHHapticPattern(events: events, parameters: [])).start(atTime: CHHapticTimeImmediate) } catch {}
      call.resolve(["supported": true])
    }
  }

  private static func tap(_ t: Double, _ i: Float, _ s: Float) -> CHHapticEvent {
    CHHapticEvent(eventType: .hapticTransient, parameters: [
      CHHapticEventParameter(parameterID: .hapticIntensity, value: i), CHHapticEventParameter(parameterID: .hapticSharpness, value: s),
    ], relativeTime: t)
  }
  private static func hum(_ t: Double, _ d: Double, _ i: Float, _ s: Float) -> CHHapticEvent {
    CHHapticEvent(eventType: .hapticContinuous, parameters: [
      CHHapticEventParameter(parameterID: .hapticIntensity, value: i), CHHapticEventParameter(parameterID: .hapticSharpness, value: s),
    ], relativeTime: t, duration: d)
  }
  static func pattern(_ n: String) -> [CHHapticEvent]? {
    switch n {
    case "bomb": return [tap(0, 1, 0.2), hum(0.02, 0.45, 0.9, 0.05), tap(0.18, 0.7, 0.1)]                     // a heavy thud, then a shudder
    case "zone": return [tap(0, 0.45, 0.6), tap(0.07, 0.65, 0.75), tap(0.14, 0.9, 0.9)]                       // a rising three-step tick
    case "orbit": return [hum(0, 0.6, 0.6, 0.4), tap(0.62, 1, 1), tap(0.74, 1, 1)]                          // build, then two cracks
    case "trick": return [tap(0, 0.5, 0.9), hum(0.03, 0.25, 0.35, 0.8)]                                    // a whip
    case "fill": return [tap(0, 0.7, 0.5)]
    case "stylefill": return [tap(0, 0.8, 0.8), tap(0.09, 1, 1), hum(0.12, 0.3, 0.6, 0.6)]
    default: return nil
    }
  }
}

// MARK: - Live Activity

@objc(LiveFlightPlugin)
public class LiveFlightPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "LiveFlightPlugin"
  public let jsName = "LiveFlight"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "supported", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
  ]

  @objc func supported(_ call: CAPPluginCall) {
    if #available(iOS 16.2, *) { call.resolve(["supported": ActivityAuthorizationInfo().areActivitiesEnabled]) } else { call.resolve(["supported": false]) }
  }

  #if canImport(ActivityKit)
  @available(iOS 16.2, *)
  private func state(_ call: CAPPluginCall, closed: Bool = false) -> FlightAttributes.ContentState {
    FlightAttributes.ContentState(
      mcap: call.getDouble("mcap") ?? 0, valueUsd: call.getDouble("valueUsd") ?? 0, pnlUsd: call.getDouble("pnlUsd") ?? 0,
      pnlPct: call.getDouble("pnlPct") ?? 0, zone: call.getString("zone") ?? "", nextZone: call.getString("nextZone") ?? "",
      zoneProgress: max(0, min(1, call.getDouble("zoneProgress") ?? 0)), closed: closed || (call.getBool("closed") ?? false), updatedAt: Date())
  }
  @available(iOS 16.2, *)
  private func current(_ coin: String?) -> Activity<FlightAttributes>? {
    Activity<FlightAttributes>.activities.first { coin == nil || $0.attributes.coin == coin }
  }
  #endif

  /// start { coin, ticker, investedUsd, entryMcap, url, ...state } → { id }. Replaces any running flight activity (one at a time).
  /// Fires "pushToken" { id, token } when Apple hands out the token the server pushes updates to.
  @objc func start(_ call: CAPPluginCall) {
    #if canImport(ActivityKit)
    guard #available(iOS 16.2, *) else { call.reject("Live Activities need iOS 16.2"); return }
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { call.reject("Live Activities are off for DISCIPLE"); return }
    let coin = call.getString("coin") ?? ""
    let attrs = FlightAttributes(coin: coin, ticker: call.getString("ticker") ?? "", investedUsd: call.getDouble("investedUsd") ?? 0,
                                 entryMcap: call.getDouble("entryMcap") ?? 0, url: call.getString("url") ?? "/")
    let st = state(call)
    Task {
      for a in Activity<FlightAttributes>.activities { await a.end(nil, dismissalPolicy: .immediate) }
      let content = ActivityContent(state: st, staleDate: Date().addingTimeInterval(15 * 60))
      // with push updates (the server keeps it fresh while the app is closed); a build without the push entitlement
      // (unsigned Simulator runs) can't get a token, so fall back to a local-only activity the app updates itself
      if let a = try? Activity.request(attributes: attrs, content: content, pushType: .token) {
        call.resolve(["id": a.id, "push": true])
        for await t in a.pushTokenUpdates {
          self.notifyListeners("pushToken", data: ["id": a.id, "coin": coin, "token": t.map { String(format: "%02x", $0) }.joined()])
        }
        return
      }
      do {
        let a = try Activity.request(attributes: attrs, content: content, pushType: nil)
        call.resolve(["id": a.id, "push": false])
      } catch { call.reject(error.localizedDescription) }
    }
    #else
    call.reject("Live Activities are not available")
    #endif
  }

  /// update { coin?, ...state }: the running activity's numbers.
  @objc func update(_ call: CAPPluginCall) {
    #if canImport(ActivityKit)
    guard #available(iOS 16.2, *), let a = current(call.getString("coin")) else { call.resolve(["running": false]); return }
    let st = state(call)
    Task { await a.update(.init(state: st, staleDate: Date().addingTimeInterval(15 * 60))); call.resolve(["running": true]) }
    #else
    call.resolve(["running": false])
    #endif
  }

  /// end { coin?, ...final state }: shows the final card for a few minutes, then leaves the lock screen.
  @objc func end(_ call: CAPPluginCall) {
    #if canImport(ActivityKit)
    guard #available(iOS 16.2, *), let a = current(call.getString("coin")) else { call.resolve(); return }
    let st = state(call, closed: true)
    Task { await a.end(.init(state: st, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(5 * 60))); call.resolve() }
    #else
    call.resolve()
    #endif
  }
}
