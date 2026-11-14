import Foundation
import Capacitor
import ActivityKit

/// Live Activity for the flight you're aboard (web/lib/native.ts nativeFlightActivity, components/flight/LiveFlight).
/// start({ ticker, path, state }) → { id } (and a "pushToken" event { id, token } for the server's updates);
/// update({ state }); end({ state? }) shows the final card for a while, then it leaves the lock screen.
@objc(DiscipleFlightPlugin)
public class DiscipleFlightPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DiscipleFlightPlugin"
    public let jsName = "DiscipleFlight"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "supported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
    ]

    @available(iOS 16.1, *)
    private func state(_ o: JSObject?) -> FlightActivityAttributes.ContentState? {
        guard let o = o else { return nil }
        return .init(mcap: o["mcap"] as? String ?? "", zone: o["zone"] as? String ?? "",
                     bagUsd: (o["bagUsd"] as? NSNumber)?.doubleValue ?? 0, pnlUsd: (o["pnlUsd"] as? NSNumber)?.doubleValue ?? 0,
                     pnlPct: (o["pnlPct"] as? NSNumber)?.doubleValue ?? 0, closed: o["closed"] as? Bool ?? false)
    }

    @objc func supported(_ call: CAPPluginCall) {
        if #available(iOS 16.2, *) { call.resolve(["liveActivities": ActivityAuthorizationInfo().areActivitiesEnabled]) }
        else { call.resolve(["liveActivities": false]) }
    }

    @objc func start(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { call.resolve(["id": NSNull()]); return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled, let st = state(call.getObject("state")) else { call.resolve(["id": NSNull()]); return }
        let attrs = FlightActivityAttributes(ticker: call.getString("ticker") ?? "", path: call.getString("path") ?? "/")
        Task {
            // one flight at a time: a new one replaces any card left from before
            for a in Activity<FlightActivityAttributes>.activities { await a.end(nil, dismissalPolicy: .immediate) }
            do {
                let a = try Activity.request(attributes: attrs, content: .init(state: st, staleDate: Date().addingTimeInterval(15 * 60)), pushType: .token)
                call.resolve(["id": a.id])
                for await data in a.pushTokenUpdates {
                    let token = data.map { String(format: "%02x", $0) }.joined()
                    self.notifyListeners("pushToken", data: ["id": a.id, "token": token])
                }
            } catch {
                call.resolve(["id": NSNull()])
            }
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *), let st = state(call.getObject("state")) else { call.resolve(); return }
        Task {
            for a in Activity<FlightActivityAttributes>.activities { await a.update(.init(state: st, staleDate: Date().addingTimeInterval(15 * 60))) }
            call.resolve()
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { call.resolve(); return }
        let st = state(call.getObject("state"))
        Task {
            for a in Activity<FlightActivityAttributes>.activities {
                await a.end(st.map { .init(state: $0, staleDate: nil) }, dismissalPolicy: .after(Date().addingTimeInterval(30 * 60)))
            }
            call.resolve()
        }
    }
}
