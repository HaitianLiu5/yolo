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
  /// `/m/{token}/comments`, or nil when the item has no timed comments.
  public let comments: String?
  /// `/m/{token}/preview`, under which `{seconds}.jpg` is a small picture of
  /// that moment for scrubbing, or nil when the stream has none.
  public let previews: String?
  /// `lan`, `wan`, or `tunnel`/`relay`: where the stream's media comes from.
  public let network: String?
  /// The cap used: `{ maxVideoKbps, ceilingKbps, capped }`.
  public let limits: JSONValue?
  /// `{ width, height, fps, videoKbps, audioKbps, split }`.
  public let profile: JSONValue?

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
    comments = json["comments"]?.string
    previews = json["previews"]?.string
    network = json["network"]?.string
    limits = json["limits"]
    profile = json["profile"]
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

extension StreamDescriptor {
  /// A media path's URL (`comments`, a subtitle): against the stream's
  /// origin on the LAN or remote path, else the server's.
  public func resolve(_ path: String, server: ServerAddress) -> URL? {
    let base = (network == "lan" || network == "wan") ? origin : nil
    return URL(string: path, relativeTo: URL(string: (base ?? origin ?? server.origin) + "/"))?.absoluteURL
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

  /// A new stream of what a session already plays (recovery, seek, quality,
  /// or tracks), not a new item.
  public var rebuilds: Bool {
    ["recovery", "seek", "quality", "tracks"].contains(reason ?? "")
  }
}

/// A press on this screen that plays something here, from the tap until
/// its `load` comes: an item or a link, a takeover of another screen's
/// session, or an agent's choice, whose item only Yolo knows.
public struct Press: Sendable, Equatable {
  public enum Target: Sendable, Equatable {
    case reference([String: JSONValue])
    case transfer
    case unknown
  }

  public let number: Int
  public let target: Target

  /// Whether `load` is this press's: the item or link pressed, the
  /// takeover's stream, or for an agent's choice any new item.
  public func answered(by load: Load) -> Bool {
    switch target {
    case .transfer:
      return load.reason == "transfer"
    case .unknown:
      return load.reason == nil || load.reason == "play"
    case .reference:
      return (load.reason == nil || load.reason == "play") && plays(load.item?["source"])
    }
  }

  /// Whether a welcome's state for this screen is this press's session,
  /// whose `load` went with the old connection: the item pressed, the
  /// takeover's session, or for an agent's choice a stream still loading.
  public func named(by state: JSONValue?) -> Bool {
    guard let state else { return false }
    switch target {
    case .transfer:
      return state["handedFrom"] != nil && state["handedFrom"]?.isNull == false
    case .unknown:
      return state["status"]?.string == "loading"
    case .reference:
      return plays(state["item"]?["source"])
    }
  }

  private func plays(_ source: JSONValue?) -> Bool {
    guard case .reference(let reference) = target, let source else { return false }
    if let url = reference["url"]?.string { return source["url"]?.string == url }
    if let pressed = reference["source"] {
      return source["plugin"] != nil && source["plugin"] == pressed["plugin"] && source["id"] == pressed["id"]
    }
    if let itemId = reference["itemId"]?.string, let plugin = source["plugin"]?.string, let id = source["id"]?.string {
      return itemId == "\(plugin):\(id)"
    }
    return false
  }
}

/// Which `load` plays while this screen waits for a press, and which one it
/// leaves: a press left with Back while it loaded is still being prepared,
/// and its `load` may come after the next press, as may the stream a
/// welcome asked for again before the press (Agent Note
/// 2026-10-23-iphone-and-ipad-client). The Hub never sends an older
/// press's `load` after a newer one's, so only those that come first are
/// in question.
public struct Presses: Sendable {
  /// The press the screen shows starting.
  public private(set) var waiting: Press?
  /// The press left with Back while it loaded, until its `load` comes or
  /// Yolo answers that none will.
  public private(set) var left: Press?
  /// The waiting press's session, asked for again after a welcome named it.
  private var recovering: String?
  private var count = 0

  public init() {}

  public enum Verdict: Sendable, Equatable {
    /// Plays; `answers` when it is the press the screen waits for.
    case play(answers: Bool)
    /// Not shown: the screen says `idle` for it at once.
    case leave
  }

  public mutating func press(_ target: Press.Target) -> Press {
    count += 1
    let press = Press(number: count, target: target)
    // The same item pressed again: whichever `load` comes is wanted.
    if left?.target == target { left = nil }
    waiting = press
    recovering = nil
    return press
  }

  /// A welcome while a press waits: whether its state names the press's
  /// own session, which the screen then asks for again.
  public mutating func welcomed(state: JSONValue?) -> Bool {
    guard let waiting, waiting.named(by: state), let sessionId = state?["sessionId"]?.string else { return false }
    recovering = sessionId
    return true
  }

  /// Back while the press loads: its `load` is left when it comes.
  @discardableResult
  public mutating func leave() -> Bool {
    guard let waiting else { return false }
    left = waiting
    self.waiting = nil
    recovering = nil
    return true
  }

  /// Yolo refused the press (superseded, or an error): no `load` comes.
  public mutating func refused(_ press: Press) {
    if waiting == press {
      waiting = nil
      recovering = nil
    }
    if left == press { left = nil }
  }

  /// Yolo's answer never reached the screen (the request failed on its
  /// way): Yolo may still play the press, so its `load` is left when it
  /// comes, as after Back.
  public mutating func lost(_ press: Press) {
    guard waiting == press else { return }
    left = press
    waiting = nil
    recovering = nil
  }

  /// Yolo answered the press, and its `load` has had time to come.
  public mutating func settled(_ press: Press) {
    if left == press { left = nil }
  }

  /// A `load` came; `onScreen` is the stream the player has, if any.
  public mutating func arrived(_ load: Load, onScreen: String?) -> Verdict {
    if waiting != nil, let recovering, load.stream.sessionId == recovering {
      waiting = nil
      self.recovering = nil
      return .play(answers: true)
    }
    if let waiting, waiting.target != .unknown, waiting.answered(by: load) {
      self.waiting = nil
      recovering = nil
      if left?.answered(by: load) == true { left = nil }
      return .play(answers: true)
    }
    if let left, left.answered(by: load) {
      self.left = nil
      return .leave
    }
    guard waiting != nil else {
      // Nothing pressed since: the next new item is the press left with
      // Back, also when Yolo found it under another id.
      if left != nil, !load.rebuilds {
        left = nil
        return .leave
      }
      return .play(answers: false)
    }
    // A new stream of a session not on screen (the welcome's recovery of
    // what played before) is not what the owner pressed; of the stream on
    // screen, it plays until the press's `load` comes.
    if load.rebuilds { return onScreen == nil ? .leave : .play(answers: false) }
    // Anything else new for this screen (an agent's choice, a press whose
    // item Yolo found under another id) takes the press's place.
    waiting = nil
    recovering = nil
    return .play(answers: true)
  }
}

/// A control command from the Hub for this screen's own session.
public enum PlaybackCommand: Sendable, Equatable {
  case pause(sessionId: String?)
  case resume(sessionId: String?)
  case seek(sessionId: String?, position: Double)
  case stop
  /// This same screen connected from somewhere else (`reason: "replaced"`),
  /// the one `deactivate` protocol 2 sends: another screen's play never
  /// stops this one (Agent Note 2026-10-31-screen-sessions).
  case deactivate

  public init?(_ message: RealtimeMessage) {
    let session = message["sessionId"]?.string
    switch message.type {
    case "pause": self = .pause(sessionId: session)
    case "resume": self = .resume(sessionId: session)
    case "seek": self = .seek(sessionId: session, position: max(0, message["position"]?.number ?? 0))
    case "stop": self = .stop
    case "deactivate" where message["reason"]?.string == "replaced": self = .deactivate
    default: return nil
    }
  }

  /// Whether the command applies to the stream on screen. A pause always
  /// goes, since it starts nothing. A resume or seek that comes ahead of its
  /// connection's welcome for another stream is for one whose `load` went
  /// with the connection before, and the welcome switches the screen to it;
  /// over a welcomed connection a stream's `load` comes ahead of its
  /// commands, so they go (Agent Note 2026-10-07-hub-and-realtime-channel).
  public func applies(to current: String?, welcomed: Bool) -> Bool {
    switch self {
    case .pause, .stop, .deactivate: true
    case .resume(let session), .seek(let session, _): welcomed || session == nil || current == nil || session == current
    }
  }

  /// The stream a pause, resume, or seek is for: the one it names, else the
  /// one on screen.
  public func stream(onScreen: String?) -> String? {
    switch self {
    case .pause(let session), .resume(let session), .seek(let session, _): session ?? onScreen
    case .stop, .deactivate: nil
    }
  }
}

/// What the screen reports about its own session: `loading`, `playing`,
/// `paused`, and `buffering`, and `idle` when it left.
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
  public var health: PlaybackHealth?

  public init(
    sessionId: String, status: PlaybackStatus, position: Double, duration: Double?, playing: Bool,
    viewport: (width: Int, height: Int)? = nil, health: PlaybackHealth? = nil
  ) {
    self.sessionId = sessionId
    self.status = status
    self.position = position
    self.duration = duration
    self.playing = playing
    self.viewport = viewport
    self.health = health
  }

  public static func == (lhs: PlaybackReport, rhs: PlaybackReport) -> Bool {
    lhs.sessionId == rhs.sessionId && lhs.status == rhs.status && lhs.position == rhs.position
      && lhs.duration == rhs.duration && lhs.playing == rhs.playing
      && lhs.viewport?.width == rhs.viewport?.width && lhs.viewport?.height == rhs.viewport?.height
      && lhs.health == rhs.health
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
    if let health { fields["health"] = health.fields }
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

/// What a welcome asks of a screen whose stream is not the Hub's: when its
/// own session is still playing a stream it does not have (an app opened
/// again, or a `load` that went with the old connection), the screen asks
/// for that stream (`reason: "recovery"`): for the item it plays, where it
/// is (`here`); for another item, or with nothing on screen, where and
/// whether Yolo says. A session another screen continued (`handedTo`) is
/// not resumed (Agent Note 2026-10-31-screen-sessions).
public struct RecoveryRequest: Sendable, Equatable {
  public let body: JSONValue

  /// `playing` is the stream this screen has, if any.
  public init?(
    welcomeState state: JSONValue?, deviceId: String?, playing: String?, network: MediaPath?,
    here: (source: JSONValue, position: Double)? = nil, now: Date = Date()
  ) {
    guard let state, let deviceId, state["deviceId"]?.string == deviceId,
          let status = state["status"]?.string, ["playing", "paused", "loading", "buffering"].contains(status),
          state["leftAt"] == nil || state["leftAt"]?.isNull == true,
          state["handedTo"] == nil || state["handedTo"]?.isNull == true,
          let sessionId = state["sessionId"]?.string, sessionId != playing,
          let source = state["item"]?["source"]
    else { return nil }
    var position = max(0, state["position"]?.number ?? 0)
    if status == "playing", let at = state["positionAt"]?.number, at > 0 {
      position += max(0, now.timeIntervalSince1970 - at / 1000)
    }
    if let here, here.source == source { position = here.position }
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
