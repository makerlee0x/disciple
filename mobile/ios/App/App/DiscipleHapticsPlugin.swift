import Foundation
import Capacitor
import CoreHaptics

/// Core Haptics for the flight (maker 2026-11-14, "make the rocket feel alive in your hand").
/// JS (web/lib/native.ts): DiscipleHaptics.start() → a looping engine rumble at level 0; setLevel({ level }) 0…1 follows the
/// thrust; play({ kind }) for one-off moments: "thud" (a bomb hits), "tick" with { count } (zones crossed, rising), "fill"
/// (a boost lands), "orbit" (escape velocity); stop() ends the rumble. Every call resolves, also on phones without a Taptic
/// Engine (supported() says which).
@objc(DiscipleHapticsPlugin)
public class DiscipleHapticsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DiscipleHapticsPlugin"
    public let jsName = "DiscipleHaptics"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "supported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLevel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private var engine: CHHapticEngine?
    private var rumble: CHHapticAdvancedPatternPlayer?
    private let canHaptic = CHHapticEngine.capabilitiesForHardware().supportsHaptics

    @objc func supported(_ call: CAPPluginCall) { call.resolve(["haptics": canHaptic]) }

    private func ensureEngine() -> CHHapticEngine? {
        guard canHaptic else { return nil }
        if let e = engine { return e }
        do {
            let e = try CHHapticEngine()
            e.playsHapticsOnly = true
            e.isAutoShutdownEnabled = false
            // the system stops the engine when the app goes to the background or audio is interrupted: restart, and the
            // rumble with it, the next time it's needed
            e.stoppedHandler = { [weak self] _ in DispatchQueue.main.async { self?.rumble = nil } }
            e.resetHandler = { [weak self] in DispatchQueue.main.async { self?.rumble = nil; try? self?.engine?.start() } }
            try e.start()
            engine = e
            return e
        } catch { return nil }
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.startRumble()
            call.resolve()
        }
    }

    private func startRumble() {
        guard let e = ensureEngine(), rumble == nil else { return }
        do {
            let ev = CHHapticEvent(eventType: .hapticContinuous, parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: 1),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.15),
            ], relativeTime: 0, duration: 30)
            let p = try e.makeAdvancedPlayer(with: CHHapticPattern(events: [ev], parameters: []))
            p.loopEnabled = true
            try e.start()
            try p.start(atTime: CHHapticTimeImmediate)
            try p.sendParameters([CHHapticDynamicParameter(parameterID: .hapticIntensityControl, value: 0, relativeTime: 0)], atTime: CHHapticTimeImmediate)
            rumble = p
        } catch { rumble = nil }
    }

    @objc func setLevel(_ call: CAPPluginCall) {
        let level = Float(max(0, min(1, call.getDouble("level") ?? 0)))
        DispatchQueue.main.async {
            if self.rumble == nil { self.startRumble() }
            // a low, soft purr at idle that gets stronger and a little sharper as the thrust builds
            let intensity = level <= 0.01 ? 0 : 0.12 + 0.5 * level
            let sharp = 0.1 + 0.35 * level
            try? self.rumble?.sendParameters([
                CHHapticDynamicParameter(parameterID: .hapticIntensityControl, value: intensity, relativeTime: 0),
                CHHapticDynamicParameter(parameterID: .hapticSharpnessControl, value: sharp - 0.15, relativeTime: 0),
            ], atTime: CHHapticTimeImmediate)
            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        let kind = call.getString("kind") ?? ""
        let count = max(1, min(6, call.getInt("count") ?? 1))
        DispatchQueue.main.async {
            guard let e = self.ensureEngine() else { call.resolve(); return }
            var events: [CHHapticEvent] = []
            func tap(_ t: Double, _ i: Float, _ s: Float) {
                events.append(CHHapticEvent(eventType: .hapticTransient, parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: i), CHHapticEventParameter(parameterID: .hapticSharpness, value: s)], relativeTime: t))
            }
            func hum(_ t: Double, _ d: Double, _ i: Float, _ s: Float) {
                events.append(CHHapticEvent(eventType: .hapticContinuous, parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: i), CHHapticEventParameter(parameterID: .hapticSharpness, value: s)], relativeTime: t, duration: d))
            }
            var curves: [CHHapticParameterCurve] = []
            switch kind {
            case "thud":   // a bomb hits: one heavy, dull blow that rolls off
                tap(0, 1, 0.15); hum(0.01, 0.35, 0.8, 0.05)
                curves.append(CHHapticParameterCurve(parameterID: .hapticIntensityControl, controlPoints: [
                    .init(relativeTime: 0.01, value: 1), .init(relativeTime: 0.36, value: 0)], relativeTime: 0))
            case "tick":   // zones crossed: quick ticks, each a little stronger and sharper
                for k in 0..<count { let f = Float(k) / Float(max(1, count - 1)); tap(Double(k) * 0.07, 0.55 + 0.4 * f, 0.6 + 0.35 * f) }
            case "fill":   // a boost lands: a firm click and a short swell
                tap(0, 0.8, 0.7); hum(0.02, 0.12, 0.5, 0.4)
            case "orbit":  // escape velocity: a long rising roar and three hits
                hum(0, 1.1, 1, 0.3)
                curves.append(CHHapticParameterCurve(parameterID: .hapticIntensityControl, controlPoints: [
                    .init(relativeTime: 0, value: 0.2), .init(relativeTime: 0.9, value: 1), .init(relativeTime: 1.1, value: 0)], relativeTime: 0))
                tap(0.9, 1, 0.9); tap(1.0, 1, 0.9); tap(1.1, 1, 1)
            default: call.resolve(); return
            }
            do {
                try e.start()
                let p = try e.makePlayer(with: CHHapticPattern(events: events, parameterCurves: curves))
                try p.start(atTime: CHHapticTimeImmediate)
            } catch { /* a missed buzz is fine */ }
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            try? self.rumble?.stop(atTime: CHHapticTimeImmediate)
            self.rumble = nil
            call.resolve()
        }
    }
}
