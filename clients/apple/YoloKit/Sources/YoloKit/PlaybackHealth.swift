import Foundation

/// The player's own measurements that ride on a report as `health`
/// (Agent Note 2026-10-07-hub-and-realtime-channel), for Yolo's playback
/// health: about every 15 seconds while playing, and at once for a new
/// stream, a new stall, or a change of buffering.
public struct PlaybackHealth: Sendable, Equatable {
  public var bufferSeconds: Double?
  public var throughputKbps: Double?
  public var buffering = false
  public var stalls = 0
  public var stallSeconds = 0.0
  /// Newest first: how long ago each stall began and how long it lasted.
  public var recentStalls: [(ago: Int, seconds: Double)] = []
  public var width: Int?
  public var height: Int?
  public var droppedFrames: Int?

  public init() {}

  public static func == (lhs: PlaybackHealth, rhs: PlaybackHealth) -> Bool {
    lhs.fields == rhs.fields
  }

  private static func tenths(_ value: Double?) -> JSONValue {
    guard let value, value.isFinite else { return .null }
    return .number((value * 10).rounded() / 10)
  }

  public var fields: JSONValue {
    [
      "engine": "native",
      "bufferSeconds": Self.tenths(bufferSeconds),
      "throughputKbps": throughputKbps.map { .number($0.rounded()) } ?? .null,
      "buffering": .bool(buffering),
      "stalls": .number(Double(stalls)),
      "stallSeconds": Self.tenths(stallSeconds),
      "recentStalls": .array(recentStalls.prefix(5).map { ["ago": .number(Double($0.ago)), "seconds": Self.tenths($0.seconds)] }),
      "width": width.map { .number(Double($0)) } ?? .null,
      "height": height.map { .number(Double($0)) } ?? .null,
      "videoCodec": .null,
      "droppedFrames": droppedFrames.map { .number(Double($0)) } ?? .null,
    ]
  }
}

/// Counts the stalls of one stream: a stall is the time playback waited
/// for data after it had started.
public struct StallCounter: Sendable {
  public static let recentKept: Duration = .seconds(600)

  private var started: [(at: ContinuousClock.Instant, ended: ContinuousClock.Instant?)] = []

  public init() {}

  public var count: Int { started.count }
  public var isStalled: Bool { started.last.map { $0.ended == nil } ?? false }

  public mutating func stalled(at now: ContinuousClock.Instant) {
    guard !isStalled else { return }
    started.append((now, nil))
  }

  public mutating func resumed(at now: ContinuousClock.Instant) {
    guard isStalled else { return }
    started[started.count - 1].ended = now
  }

  public func seconds(at now: ContinuousClock.Instant) -> Double {
    started.reduce(0) { $0 + Self.seconds(($1.ended ?? now) - $1.at) }
  }

  public func recent(at now: ContinuousClock.Instant) -> [(ago: Int, seconds: Double)] {
    started.filter { now - $0.at < Self.recentKept }.reversed().map {
      (Int(Self.seconds(now - $0.at).rounded()), Self.seconds(($0.ended ?? now) - $0.at))
    }
  }

  static func seconds(_ duration: Duration) -> Double {
    let (seconds, attoseconds) = duration.components
    return Double(seconds) + Double(attoseconds) / 1e18
  }
}

/// When a report carries `health`: once per stream, stall, and change of
/// buffering, and otherwise every 15 seconds.
public struct HealthPacer: Sendable {
  public static let interval: Duration = .seconds(15)

  private var lastKey: String?
  private var lastAt: ContinuousClock.Instant?

  public init() {}

  public mutating func take(sessionId: String, stalls: Int, buffering: Bool, at now: ContinuousClock.Instant) -> Bool {
    let key = "\(sessionId):\(stalls):\(buffering)"
    if key == lastKey, let lastAt, now - lastAt < Self.interval { return false }
    lastKey = key
    lastAt = now
    return true
  }
}
