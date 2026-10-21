import Foundation

/// A `load`'s stream: the node's `prepare` answer
/// (Agent Note 2026-10-11-node-media-pipeline, The stream descriptor).
public struct StreamDescriptor: Sendable, Equatable {
  public let sessionId: String
  /// `hls`, `mp4`, or `split-mp4` (never sent to `native`: the node joins
  /// split files for it).
  public let deliveryType: String
  /// The delivery's path or URL, as Yolo sent it.
  public let url: String?
  /// The media origin the stream's URLs resolve against: the LAN or remote
  /// listener, or null for the server's own (the relay).
  public let origin: String?
  public let title: String?
  public let duration: Double?
  public let isLive: Bool
  public let startTime: Double?
  /// The node may have trimmed an HLS playlist to `startTime`: the stream
  /// then begins part way into the item (StreamTimeline).
  public let trimToStart: Bool
  public let thumbnail: String?
  public let tracks: JSONValue?

  public init?(json: JSONValue?) {
    guard let json, let sessionId = json["sessionId"]?.string else { return nil }
    self.sessionId = sessionId
    deliveryType = json["delivery"]?["type"]?.string ?? "hls"
    url = json["delivery"]?["url"]?.string
    origin = json["origin"]?.string
    title = json["title"]?.string
    duration = json["duration"]?.number
    isLive = json["isLive"]?.bool ?? false
    startTime = json["startTime"]?.number
    trimToStart = json["trimToStart"]?.bool ?? false
    thumbnail = json["thumbnail"]?.string
    tracks = json["tracks"]
  }

  /// The URL AVPlayer opens: every media URL resolves against the stream's
  /// `origin`, else the server's (Agent Note 2026-10-19-client-protocol,
  /// Media). Nil for a delivery this client cannot open.
  public func mediaURL(server: ServerAddress) -> URL? {
    guard deliveryType == "hls" || deliveryType == "mp4", let url, !url.isEmpty else { return nil }
    let base = origin.flatMap { URL(string: $0 + "/") } ?? URL(string: server.origin + "/")
    return URL(string: url, relativeTo: base)?.absoluteURL
  }
}

/// Where a stream begins in its item. AVPlayer counts from the stream's
/// first segment, which for a transcode resumed part way (`trimToStart`) is
/// not the item's beginning, and native HLS does not say where the media's
/// own timestamps start; so the part of the item's duration the stream
/// lacks stands in for it, as the player's `<video>` engine reads Safari's
/// native HLS (`native-video-player.js`). Positions Yolo hears and sends are
/// the item's.
public struct StreamTimeline: Sendable, Equatable {
  public static let minimumOffset = 0.5

  /// Seconds of the item before the stream's first segment.
  public let offset: Double

  public init(offset: Double = 0) {
    self.offset = offset
  }

  /// At most a segment before the start position and never after it; any
  /// other gap is not a trim, and the stream counts from the item's start.
  public init(trimToStart: Bool, itemDuration: Double?, streamDuration: Double?, startTime: Double, isLive: Bool, tolerance: Double = 12) {
    guard trimToStart, !isLive, let item = itemDuration, item > 0, let stream = streamDuration, stream > 0, stream.isFinite, startTime > 0 else {
      self.offset = 0
      return
    }
    let missing = item - stream
    let trimmed = missing >= Self.minimumOffset && missing <= startTime + 1 && startTime - missing <= tolerance
    self.offset = trimmed ? missing : 0
  }

  public func itemTime(_ streamTime: Double) -> Double { offset + streamTime }

  /// The stream's time for an item position, or nil before the stream's
  /// first segment, which takes a stream of its own.
  public func streamTime(_ itemTime: Double) -> Double? {
    itemTime + 0.001 < offset ? nil : max(0, itemTime - offset)
  }
}

/// The Hub's `load`: play this stream on this screen.
public struct Load: Sendable, Equatable {
  public let stream: StreamDescriptor
  /// The item with its Source, needed to ask for this stream again.
  public let item: JSONValue?
  public let startTime: Double
  public let autoplay: Bool
  /// `play`, `recovery`, `seek`, `quality`, `transfer`, or `tracks`.
  public let reason: String?

  public init?(_ message: RealtimeMessage) {
    guard message.type == "load", let stream = StreamDescriptor(json: message["stream"]) else { return nil }
    self.stream = stream
    item = message["item"]
    startTime = max(0, message["startTime"]?.number ?? stream.startTime ?? 0)
    autoplay = message["autoplay"]?.bool ?? true
    reason = message["reason"]?.string
  }
}

/// A control command from the Hub for the active screen.
public enum PlaybackCommand: Sendable, Equatable {
  case pause(sessionId: String?)
  case resume(sessionId: String?)
  case seek(sessionId: String?, position: Double)
  case stop
  /// Playback moved to another device; `replaced` when this same device
  /// connected from somewhere else.
  case deactivate(replaced: Bool)

  public init?(_ message: RealtimeMessage) {
    let session = message["sessionId"]?.string
    switch message.type {
    case "pause": self = .pause(sessionId: session)
    case "resume": self = .resume(sessionId: session)
    case "seek": self = .seek(sessionId: session, position: max(0, message["position"]?.number ?? 0))
    case "stop": self = .stop
    case "deactivate": self = .deactivate(replaced: message["reason"]?.string == "replaced")
    default: return nil
    }
  }

  /// Whether the command applies to the stream on screen. A pause always
  /// goes, since it starts nothing; a resume or seek for another stream is
  /// for one whose `load` went with an older connection, and the welcome
  /// switches the screen to it (Agent Note 2026-10-07-hub-and-realtime-channel).
  public func applies(to current: String?) -> Bool {
    switch self {
    case .pause, .stop, .deactivate: true
    case .resume(let session), .seek(let session, _): session == nil || session == current
    }
  }
}

/// What the screen reports: the Hub takes `loading`, `playing`, `paused`,
/// and `buffering` from the active device, and `idle` when it left.
public enum PlaybackStatus: String, Sendable, Equatable {
  case loading
  case playing
  case paused
  case buffering
  case idle
}

public struct PlaybackReport: Sendable, Equatable {
  public let sessionId: String
  public let status: PlaybackStatus
  public let position: Double
  /// Nil for a live stream.
  public let duration: Double?
  public let playing: Bool
  /// In physical pixels.
  public let viewport: (width: Int, height: Int)?

  public init(sessionId: String, status: PlaybackStatus, position: Double, duration: Double?, playing: Bool, viewport: (width: Int, height: Int)? = nil) {
    self.sessionId = sessionId
    self.status = status
    self.position = position
    self.duration = duration
    self.playing = playing
    self.viewport = viewport
  }

  public static func == (lhs: PlaybackReport, rhs: PlaybackReport) -> Bool {
    lhs.sessionId == rhs.sessionId && lhs.status == rhs.status && lhs.position == rhs.position
      && lhs.duration == rhs.duration && lhs.playing == rhs.playing
      && lhs.viewport?.width == rhs.viewport?.width && lhs.viewport?.height == rhs.viewport?.height
  }

  /// The `report` message's fields.
  public var fields: [String: JSONValue] {
    var fields: [String: JSONValue] = [
      "sessionId": .string(sessionId),
      "status": .string(status.rawValue),
      "position": .number((max(0, position) * 1000).rounded() / 1000),
      "duration": duration.map { .number($0) } ?? .null,
      "playing": .bool(playing),
    ]
    if let viewport {
      fields["viewport"] = ["width": .number(Double(viewport.width)), "height": .number(Double(viewport.height)), "devicePixelRatio": 1]
    }
    return fields
  }
}

/// When to send a report, as the player paces them: a change of status or
/// stream at once, otherwise at least every 5 seconds, and never closer than
/// 750 ms, far below the Hub's 30 messages per 10 seconds.
public struct ReportPacer: Sendable {
  public static let interval: Duration = .seconds(5)
  public static let minimumSpacing: Duration = .milliseconds(750)

  private var lastAt: ContinuousClock.Instant?
  private var lastStatus: PlaybackStatus?
  private var lastSession: String?

  public init() {}

  public func due(_ report: PlaybackReport, at now: ContinuousClock.Instant, force: Bool = false) -> Bool {
    guard let lastAt else { return true }
    if force { return true }
    let changed = report.status != lastStatus || report.sessionId != lastSession
    let since = now - lastAt
    return changed ? since >= Self.minimumSpacing || report.sessionId != lastSession : since >= Self.interval
  }

  public mutating func sent(_ report: PlaybackReport, at now: ContinuousClock.Instant) {
    lastAt = now
    lastStatus = report.status
    lastSession = report.sessionId
  }
}

/// What a welcome asks of a screen that plays nothing of its own yet, such
/// as an app opened again: when `state` names this device still playing a
/// stream it does not have, the screen asks for a new stream where Yolo says
/// it is (`reason: "recovery"`).
public struct RecoveryRequest: Sendable, Equatable {
  public let body: JSONValue

  /// `playing` is the stream this screen has, if any.
  public init?(welcomeState state: JSONValue?, deviceId: String?, playing: String?, network: MediaPath?, now: Date = Date()) {
    guard let state, let deviceId, state["deviceId"]?.string == deviceId,
          let status = state["status"]?.string, ["playing", "paused", "loading", "buffering"].contains(status),
          state["leftAt"] == nil || state["leftAt"]?.isNull == true,
          let sessionId = state["sessionId"]?.string, sessionId != playing,
          let source = state["item"]?["source"]
    else { return nil }
    var position = max(0, state["position"]?.number ?? 0)
    if status == "playing", let at = state["positionAt"]?.number, at > 0 {
      position += max(0, now.timeIntervalSince1970 - at / 1000)
    }
    if let duration = state["item"]?["duration"]?.number, duration > 0, state["item"]?["isLive"]?.bool != true {
      position = min(position, duration)
    }
    var body: [String: JSONValue] = [
      "source": source,
      "startTime": .number((position * 1000).rounded() / 1000),
      "reason": "recovery",
      "autoplay": .bool(status != "paused"),
      "sessionId": .string(sessionId),
      "deviceId": .string(deviceId),
    ]
    body["network"] = network.map { .string($0.rawValue) } ?? .null
    self.body = .object(body)
  }
}

extension APIClient {
  /// Asks Yolo to play on a device (`POST /v1/playback/play`); the stream
  /// arrives as a `load` on the realtime channel. Resolving a source can take
  /// tens of seconds.
  public func play(_ body: JSONValue) async throws {
    var client = self
    client.timeout = 90
    try await client.request("/v1/playback/play", method: "POST", body: body)
  }
}
