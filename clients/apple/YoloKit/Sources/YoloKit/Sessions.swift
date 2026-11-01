import Foundation

/// Who is watching: whose history a session writes and whose track choices
/// it remembers (Agent Note 2026-10-31-screen-sessions, Profiles). The
/// owner's is always first, with the reserved id `owner`.
public struct Profile: Sendable, Hashable, Identifiable {
  public static let ownerID = "owner"

  public let id: String
  public let name: String

  public init(id: String, name: String) {
    self.id = id
    self.name = name
  }

  public init?(json: JSONValue?) {
    guard let json, let id = json["id"]?.string else { return nil }
    self.init(id: id, name: json["name"]?.string ?? id)
  }

  public var isOwner: Bool { id == Self.ownerID }
}

/// One screen's session, a `PlaybackState` from the Hub: every screen plays
/// on its own, and the `state` broadcast's `deviceId` says whose it is
/// (Agent Note 2026-10-31-screen-sessions).
public struct ScreenSession: Sendable, Equatable, Identifiable {
  public static let inUseStatuses: Set<String> = ["playing", "loading", "buffering"]
  /// A paused session stays in use this long, as `sessionInUse()` in
  /// `@useyolo/core`.
  public static let pausedInUse: TimeInterval = 30 * 60

  public let deviceId: String
  public let sessionId: String?
  public let status: String
  /// The item with its Source; nil when the screen plays nothing.
  public let item: JSONValue?
  public let position: Double
  /// When `position` was reported, in seconds since 1970.
  public let positionAt: Double?
  public let updatedAt: Double?
  public let profile: Profile
  /// The screen that continued this session, which is paused since.
  public let handedTo: String?
  public let handedFrom: String?

  public var id: String { deviceId }

  /// Nil for a state that names no screen (an empty one).
  public init?(json: JSONValue?) {
    guard let json, let deviceId = json["deviceId"]?.string else { return nil }
    self.deviceId = deviceId
    sessionId = json["sessionId"]?.string
    status = json["status"]?.string ?? "idle"
    item = json["item"].flatMap { $0.isNull ? nil : $0 }
    position = max(0, json["position"]?.number ?? 0)
    positionAt = json["positionAt"]?.number.flatMap { $0 > 0 ? $0 / 1000 : nil }
    updatedAt = json["updatedAt"]?.number.map { $0 / 1000 }
    profile = Profile(json: json["profile"]) ?? Profile(id: Profile.ownerID, name: "Me")
    handedTo = json["handedTo"]?["deviceId"]?.string
    handedFrom = json["handedFrom"]?["deviceId"]?.string
  }

  public var title: String? { item?["title"]?.string }
  public var thumbnail: String? { item?["thumbnail"]?.string }
  public var duration: Double? { item?["duration"]?.number }
  public var isLive: Bool { item?["isLive"]?.bool ?? false }
  public var source: JSONValue? { item?["source"] }

  /// The position now, moved on from the last report while it plays.
  public func livePosition(at now: Date = Date()) -> Double {
    guard status == "playing", let positionAt else { return position }
    let moved = position + max(0, now.timeIntervalSince1970 - positionAt)
    if let duration, duration > 0, !isLive { return min(duration, moved) }
    return moved
  }

  /// Within a minute (or the last 5%) of its end, as the player's store reads it.
  public var finished: Bool {
    guard let duration, duration > 0, !isLive else { return false }
    return position >= duration - min(60, duration * 0.05)
  }

  /// `sessionInUse()`: an item, a screen online, not continued elsewhere, and
  /// playing, or paused within the last 30 minutes.
  public func inUse(online: Bool, now: Date = Date()) -> Bool {
    guard item != nil, online, handedTo == nil else { return false }
    if Self.inUseStatuses.contains(status) { return true }
    guard status == "paused", let updatedAt else { return false }
    return now.timeIntervalSince1970 - updatedAt < Self.pausedInUse
  }
}

/// A paired screen as the `devices` broadcast lists it: its default
/// profile's id, and whether its session is in use (`active`).
public struct ScreenDevice: Sendable, Equatable, Identifiable {
  public let id: String
  public let name: String
  public let kind: String?
  public let online: Bool
  public let active: Bool
  public let profile: String?

  public init?(json: JSONValue) {
    guard let id = json["id"]?.string else { return nil }
    self.id = id
    name = json["name"]?.string ?? id
    kind = json["kind"]?.string
    online = json["online"]?.bool ?? false
    active = json["active"]?.bool ?? false
    profile = json["profile"]?.string
  }

  /// A remote control, which cannot play.
  public var canPlay: Bool { kind != "remote" }
}

/// Every screen's session as this one hears them over protocol 2: its own,
/// the others' by device id, who watches here, and the screens (Agent Note
/// 2026-10-31-screen-sessions, Protocol).
public struct Sessions: Sendable, Equatable {
  /// This screen's own session; nil while it plays nothing.
  public private(set) var own: ScreenSession?
  /// Every other screen's session that has an item, by device id.
  public private(set) var others: [String: ScreenSession] = [:]
  /// This screen's default profile.
  public private(set) var profile: Profile?
  /// The owner's first.
  public private(set) var profiles: [Profile] = []
  public private(set) var devices: [ScreenDevice] = []
  public private(set) var deviceId: String?

  public init() {}

  /// A welcome's: its own state, the other sessions, and the profiles.
  public mutating func welcome(_ welcome: Welcome) {
    deviceId = welcome.deviceId ?? deviceId
    own = ScreenSession(json: welcome.state).flatMap { $0.deviceId == deviceId ? $0 : nil }
    others = [:]
    for json in welcome.sessions {
      guard let session = ScreenSession(json: json), session.deviceId != deviceId, session.item != nil else { continue }
      others[session.deviceId] = session
    }
    if !welcome.profiles.isEmpty { profiles = welcome.profiles }
    profile = welcome.profile ?? profile
  }

  /// A `state` broadcast. True when it is this screen's own session; another
  /// screen's is kept while it has an item.
  @discardableResult
  public mutating func state(_ json: JSONValue?) -> Bool {
    guard let json, let session = ScreenSession(json: json) else {
      // A state that names no screen is an empty one: this screen's own.
      own = nil
      return true
    }
    if session.deviceId == deviceId {
      own = session
      return true
    }
    if session.item != nil, session.status != "idle" {
      others[session.deviceId] = session
    } else {
      others[session.deviceId] = nil
    }
    return false
  }

  /// A `devices` broadcast; `profiles` comes with it on protocol 2.
  public mutating func devices(_ json: JSONValue?, profiles list: JSONValue?) {
    devices = json?.array?.compactMap(ScreenDevice.init(json:)) ?? []
    if let list = list?.array?.compactMap(Profile.init(json:)), !list.isEmpty { profiles = list }
    if let mine = devices.first(where: { $0.id == deviceId })?.profile {
      profile = profiles.first { $0.id == mine } ?? profile
    }
    // A removed screen's session goes with it.
    let paired = Set(devices.map(\.id))
    if !devices.isEmpty { others = others.filter { paired.contains($0.key) } }
  }

  public func device(_ id: String?) -> ScreenDevice? {
    devices.first { $0.id == id }
  }

  public func name(of deviceId: String?) -> String? {
    device(deviceId)?.name
  }

  /// "Continue from another screen" (`continueCandidates()` in the player's
  /// `store.js`): other screens' sessions of the owner's profile or this
  /// screen's own default one, with an item not finished, newest first,
  /// offline screens' too (a parked car's), at most `max`. When another
  /// screen continued this one's own session, that one comes first.
  public func continueCandidates(max: Int = 3) -> [ScreenSession] {
    let mine = profile?.id ?? Profile.ownerID
    var candidates = others.values
      .filter { $0.item != nil && $0.status != "idle" && !$0.finished }
      .filter { [Profile.ownerID, mine].contains($0.profile.id) }
      .sorted { ($0.updatedAt ?? 0, $0.deviceId) > ($1.updatedAt ?? 0, $1.deviceId) }
    candidates = Array(candidates.prefix(max))
    if let handedTo = own?.handedTo, let at = candidates.firstIndex(where: { $0.deviceId == handedTo }), at > 0 {
      candidates.insert(candidates.remove(at: at), at: 0)
    }
    return candidates
  }

  /// Where "Move to" can send this screen's session: the other screens
  /// online that can play (`transferTargets()` in `play-target.js`).
  public var moveTargets: [ScreenDevice] {
    devices.filter { $0.id != deviceId && $0.online && $0.canPlay }
  }
}

/// A `screen_busy` refusal: someone else is watching on the screen a move
/// or a play named. The screen asks before it sends `replace: true`.
public struct BusyScreen: Sendable, Equatable {
  public let deviceId: String
  public let name: String
  public let title: String?
  /// Nil when it is the owner's own profile.
  public let profile: Profile?

  public init?(_ error: YoloAPIError) {
    guard error.code == "screen_busy", let details = error.details, let deviceId = details["deviceId"]?.string else { return nil }
    self.deviceId = deviceId
    name = details["name"]?.string ?? deviceId
    title = details["item"]?["title"]?.string
    profile = Profile(json: details["profile"]).flatMap { $0.isOwner ? nil : $0 }
  }

  /// "Family is watching Title on Living room TV."
  public var question: String {
    "\(profile?.name ?? "Someone") is watching \(title ?? "something") on \(name)."
  }
}

extension APIClient {
  /// Continues `from`'s session on `deviceId`, or moves this one's there
  /// (`PUT /v1/playback/device`): the item at its position, its tracks, what
  /// follows, and its queue; `from` pauses. Throws `screen_busy` when
  /// someone else is watching on `deviceId` and the request is not made from
  /// it, unless `replace`.
  public func transfer(to deviceId: String, from: String, replace: Bool = false) async throws {
    var client = self
    client.timeout = 90
    var body: [String: JSONValue] = ["deviceId": .string(deviceId), "from": .string(from)]
    if replace { body["replace"] = true }
    try await client.request("/v1/playback/device", method: "PUT", body: .object(body))
  }

  /// Resolves sessions' items ahead where they would start
  /// (`POST /v1/playback/warm`), so continuing one starts as fast as a warmed
  /// history item. Best effort.
  public func warm(_ entries: [(source: JSONValue, startTime: Double)], network: MediaPath?) async {
    guard !entries.isEmpty else { return }
    let list: [JSONValue] = entries.map { ["source": $0.source, "startTime": .number(($0.startTime * 1000).rounded() / 1000)] }
    var body: [String: JSONValue] = ["sources": .array(list)]
    if let network { body["network"] = .string(network.rawValue) }
    _ = try? await request("/v1/playback/warm", method: "POST", body: .object(body))
  }
}
