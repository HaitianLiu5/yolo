import Foundation

/// One card of a row Yolo fills by itself: what is on now, what is new, and
/// last night's games (Agent Note 2026-11-04-living-home-and-media-pool). The
/// node builds the rows and a screen only draws them, as the player's
/// `feed-rows.js` does.
public struct FeedItem: Sendable, Hashable, Identifiable {
  /// Whether it is a broadcast: `live`, `upcoming`, or `ended`.
  public struct Live: Sendable, Hashable {
    public let state: String
    public let startsAt: Date?
  }

  /// A game's two sides, each with its badge, and the score while it is on.
  public struct Matchup: Sendable, Hashable {
    public struct Side: Sendable, Hashable {
      public let name: String
      public let badge: String?
      public let score: String?
    }

    public let left: Side
    public let right: Side
    public let period: String?

    /// The score between the sides, else "vs".
    public var score: String {
      guard let left = left.score, let right = right.score else { return "vs" }
      return "\(left) – \(right)"
    }
  }

  /// Why it is on the home: a team or a channel the profile follows.
  public struct Why: Sendable, Hashable {
    /// `team`, `channel`, or what the node names.
    public let kind: String?
    public let title: String
    /// The interest "Stop following" mutes.
    public let interest: String?
  }

  /// What a card's corner says.
  public enum Badge: Sendable, Hashable {
    case live
    case upcoming(Date?)
    case new
  }

  /// The card plays its Source, as a history entry does, and keeps its
  /// progress and watched mark.
  public let item: MediaItem
  public let live: Live?
  public let matchup: Matchup?
  public let why: Why?
  /// When it was published.
  public let at: Date?

  public var id: String { item.id }

  /// A card is new for 48 hours after it was published.
  public static let newFor: TimeInterval = 48 * 3600

  public init?(json: JSONValue) {
    // Its id is its Source key, as the node names it.
    guard let item = MediaItem(playing: json) ?? MediaItem(history: json) else { return nil }
    self.item = item
    live = json["live"]?["state"]?.string.map { Live(state: $0, startsAt: Self.date(json["live"]?["startsAt"])) }
    at = Self.date(json["at"])
    why = json["why"]?["title"]?.string.flatMap { $0.isEmpty ? nil : $0 }.map {
      Why(kind: json["why"]?["kind"]?.string, title: $0, interest: json["why"]?["interest"]?.string)
    }
    let side = { (value: JSONValue?) -> Matchup.Side? in
      guard let name = value?["name"]?.string else { return nil }
      let score = value?["score"]?.string ?? value?["score"]?.int.map(String.init)
      return Matchup.Side(name: name, badge: value?["badge"]?.string, score: score)
    }
    if let left = side(json["matchup"]?["left"]), let right = side(json["matchup"]?["right"]) {
      matchup = Matchup(left: left, right: right, period: json["matchup"]?["period"]?.string)
    } else {
      matchup = nil
    }
  }

  public var isLive: Bool { live?.state == "live" }
  public var isUpcoming: Bool { live?.state == "upcoming" }

  /// `LIVE`, a start time, or `New` for 48 hours; an ended game's says nothing.
  public func badge(now: Date = Date()) -> Badge? {
    switch live?.state {
    case "live": return .live
    case "upcoming": return .upcoming(live?.startsAt)
    case "ended": return nil
    default:
      guard let at, now.timeIntervalSince(at) < Self.newFor else { return nil }
      return .new
    }
  }

  /// Milliseconds since 1970, as the node sends them, or an ISO 8601 time.
  private static func date(_ value: JSONValue?) -> Date? {
    if let ms = value?.number, ms > 0 { return Date(timeIntervalSince1970: ms / 1000) }
    return value?.string.flatMap { try? Date($0, strategy: .iso8601) }
  }
}

/// One of the rows: `live`, `new`, or `replays`.
public struct FeedRow: Sendable, Hashable, Identifiable {
  public let role: String
  public let items: [FeedItem]
  public var id: String { role }
}

/// What `GET /v1/feed/rows` answers.
public struct Feed: Sendable, Hashable {
  public let rows: [FeedRow]
  /// The node is still reading what the profile follows: rows are seconds away.
  public let reading: Bool

  public init(rows: [FeedRow] = [], reading: Bool = false) {
    self.rows = rows
    self.reading = reading
  }

  public init(json: JSONValue) {
    rows = (json["rows"]?.array ?? []).compactMap { row in
      guard let role = row["role"]?.string ?? row["id"]?.string else { return nil }
      let items = (row["items"]?.array ?? []).compactMap(FeedItem.init(json:))
      return items.isEmpty ? nil : FeedRow(role: role, items: items)
    }
    reading = json["reading"]?.bool ?? false
  }

  public func row(_ role: String) -> [FeedItem] {
    rows.first { $0.role == role }?.items ?? []
  }

  /// When to ask again while the home shows: every 10 seconds while the node
  /// still reads, every minute while something is on, else every 5 minutes.
  public var refreshAfter: Duration {
    if reading { return .seconds(10) }
    return rows.contains { $0.role == "live" } ? .seconds(60) : .seconds(300)
  }

  /// Without one card: what "Not interested" hides at once.
  public func without(_ item: FeedItem) -> Feed {
    Feed(rows: rows.compactMap { row in
      let items = row.items.filter { $0.id != item.id }
      return items.isEmpty ? nil : FeedRow(role: row.role, items: items)
    }, reading: reading)
  }

  /// Without every card an interest brought: what "Stop following" hides.
  public func without(interest: String) -> Feed {
    Feed(rows: rows.compactMap { row in
      let items = row.items.filter { $0.why?.interest != interest }
      return items.isEmpty ? nil : FeedRow(role: row.role, items: items)
    }, reading: reading)
  }
}

extension APIClient {
  /// The home's rows Yolo fills by itself. An older server has none.
  public func feed(limit: Int = 30) async throws -> Feed {
    do {
      return Feed(json: try await request("/v1/feed/rows?limit=\(limit)"))
    } catch let error as YoloAPIError where error.status == 404 {
      return Feed()
    }
  }

  /// "Not interested": the item does not come back on this profile's home.
  public func notInterested(_ item: FeedItem) async throws {
    guard let source = item.item.source else { return }
    try await request("/v1/feed/feedback", method: "POST", body: ["signal": "not_interested", "source": source])
  }

  /// "Stop following": the interest is muted and never proposed again.
  public func stopFollowing(_ interest: String) async throws {
    try await request("/v1/feed/feedback", method: "POST", body: ["signal": "stop_following", "interest": .string(interest)])
  }
}
