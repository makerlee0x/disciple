import Foundation
import ActivityKit

/// The flight on the lock screen and in the Dynamic Island (maker 2026-11-14). Shared by the app (DiscipleFlightPlugin starts
/// and updates it) and the DiscipleWidgets extension (draws it). The server keeps it current while the app is closed
/// (web/lib/server/liveActivity.ts, APNs push type "liveactivity"); its JSON keys must match ContentState below.
@available(iOS 16.1, *)
public struct FlightActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// market cap, already formatted ("$94.2K")
        public var mcap: String
        /// the zone the rocket is in ("STRATOSPHERE")
        public var zone: String
        /// what your bag is worth now, $
        public var bagUsd: Double
        /// open profit or loss on the bag, $ and %
        public var pnlUsd: Double
        public var pnlPct: Double
        /// true once you've cashed out (the final card)
        public var closed: Bool
    }
    /// "$PEPE"
    public var ticker: String
    /// in-site path a tap opens ("/play?coin=0x…")
    public var path: String
}
