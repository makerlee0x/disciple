import UIKit
import Capacitor

/// The app's web view controller: Capacitor's, plus the DISCIPLE plugins that live in this target
/// (DiscipleHaptics = Core Haptics engine feel, DiscipleFlight = the lock screen / Dynamic Island Live Activity).
class DiscipleBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(DiscipleHapticsPlugin())
        bridge?.registerPluginInstance(DiscipleFlightPlugin())
    }
}
