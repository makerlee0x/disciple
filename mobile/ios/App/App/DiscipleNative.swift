// Native extras for the DISCIPLE app shell (maker 2026-11-14, phone flight upgrades):
//  - DiscipleHaptics: a continuous Core Haptics "engine rumble" driven by the flight's thrust, plus richer one-shot patterns
//  - LiveFlight: the flight on the lock screen and in the Dynamic Island (ActivityKit), see Shared/FlightActivity.swift
// Both are reached from the site through window.Capacitor.Plugins (web/lib/native.ts); in a browser they simply don't exist.
import UIKit
import Capacitor
import CoreHaptics
import AuthenticationServices
import WebKit
#if canImport(ActivityKit)
import ActivityKit
#endif

/// The storyboard's view controller (Main.storyboard customClass): Capacitor's bridge, plus our two local plugins.
class MainViewController: CAPBridgeViewController {
  override open func capacitorDidLoad() {
    bridge?.registerPluginInstance(DiscipleHapticsPlugin())
    bridge?.registerPluginInstance(LiveFlightPlugin())
    bridge?.registerPluginInstance(NativeAuthPlugin())
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

// MARK: - Sign-in (X / Google / Apple through the system sheet)

/// Social sign-in in the app (TestFlight build 1 feedback: X opened a browser, Google wasn't offered, Apple failed).
/// Google refuses OAuth inside embedded web views, and inside the web view X can't reuse the login you already have. So when
/// the site (Privy) navigates to a provider's authorize page, this cancels that load and opens the same page in iOS's
/// ASWebAuthenticationSession instead: the system sign-in sheet, which shares Safari's logins (one tap when already signed
/// in) and which Google allows. Privy's customOAuthRedirectUrl (web/components/PrivyMount.tsx) sends the result to
/// disciple://oauth?…, which ends the sheet; the app then reloads the page it was on with those parameters, and the Privy
/// SDK finishes signing in with the PKCE verifier it kept in the web view. Recognised: any authorize URL whose
/// redirect_uri is Privy's (auth.privy.io), so no provider list needs keeping.
@objc(NativeAuthPlugin)
public class NativeAuthPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
  public let identifier = "NativeAuthPlugin"
  public let jsName = "NativeAuth"
  public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "supported", returnType: CAPPluginReturnPromise)]
  static let scheme = "disciple"
  private var session: ASWebAuthenticationSession?

  @objc func supported(_ call: CAPPluginCall) { call.resolve(["supported": true, "scheme": Self.scheme]) }

  /// An OAuth authorize request headed back to Privy (the only thing this plugin takes over).
  static func isPrivyAuthorize(_ url: URL) -> Bool {
    guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false), c.host != "auth.privy.io" else { return false }
    guard let r = c.queryItems?.first(where: { $0.name == "redirect_uri" })?.value, let ru = URL(string: r) else { return false }
    return ru.host == "auth.privy.io"
  }

  override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
    guard let url = navigationAction.request.url, Self.isPrivyAuthorize(url) else { return nil }
    DispatchQueue.main.async { self.open(url) }
    return true   // cancel the in-web-view load: the system sheet takes it
  }

  private func open(_ url: URL) {
    session?.cancel()
    let back = bridge?.webView?.url   // the page that started sign-in
    let s = ASWebAuthenticationSession(url: url, callbackURLScheme: Self.scheme) { [weak self] callback, error in
      DispatchQueue.main.async {
        self?.session = nil
        guard let wv = self?.bridge?.webView else { return }
        guard error == nil, let cb = callback, var page = URLComponents(url: back ?? wv.url ?? URL(string: "https://www.disciple.vip/")!, resolvingAgainstBaseURL: false) else {
          // cancelled or failed: reload the page so Privy's window isn't left spinning
          wv.reload(); return
        }
        // privy_oauth_code / privy_oauth_state / privy_oauth_provider onto the page that started it
        let extra = URLComponents(url: cb, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let keep = (page.queryItems ?? []).filter { q in !extra.contains(where: { $0.name == q.name }) }
        page.queryItems = keep + extra
        if let u = page.url { wv.load(URLRequest(url: u)) }
      }
    }
    s.presentationContextProvider = self
    s.prefersEphemeralWebBrowserSession = false   // share Safari's cookies: already signed in to X / Google = one tap
    session = s
    if !s.start() { session = nil; bridge?.webView?.reload() }
  }

  public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    bridge?.webView?.window ?? ASPresentationAnchor()
  }
}
