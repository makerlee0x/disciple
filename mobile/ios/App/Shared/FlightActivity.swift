// DISCIPLE Live Activity data (lock screen + Dynamic Island), shared by the App and the FlightWidget extension.
// The App starts / updates / ends it (LiveFlightPlugin, from the site's components/native/LiveFlight); the server keeps it
// fresh while the app is closed with "liveactivity" pushes (web/lib/server/liveActivity.ts) whose content-state matches State.
import Foundation
#if canImport(ActivityKit)
import ActivityKit

@available(iOS 16.1, *)
public struct FlightAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    /// coin market cap now ($): the rocket's altitude
    public var mcap: Double
    /// what the bag is worth now ($), and profit vs what went in ($ and %)
    public var valueUsd: Double
    public var pnlUsd: Double
    public var pnlPct: Double
    /// zone the rocket is in ("STRATOSPHERE"), the next one, and 0..1 of the way there
    public var zone: String
    public var nextZone: String
    public var zoneProgress: Double
    /// true once the position is closed (the final card)
    public var closed: Bool
    public var updatedAt: Date
  }
  public var coin: String
  public var ticker: String
  public var investedUsd: Double
  public var entryMcap: Double
  /// in-site path the activity opens ("/coin/0x…")
  public var url: String
}
#endif
