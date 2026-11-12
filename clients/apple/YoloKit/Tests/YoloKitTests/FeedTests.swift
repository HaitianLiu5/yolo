import Foundation
import Testing
@testable import YoloKit

// Agent Note 2026-11-04-living-home-and-media-pool.
@Suite struct FeedTests {
  static let now = Date(timeIntervalSince1970: 1_800_000_000)
  static func ms(_ date: Date) -> JSONValue { .number(date.timeIntervalSince1970 * 1000) }

  static let answer: JSONValue = [
    "available": true, "reading": false,
    "rows": [
      ["id": "live", "role": "live", "items": [
        ["id": "games:1", "source": ["plugin": "games", "id": "1"], "title": "A vs B",
         "live": ["state": "live", "startsAt": ms(now.addingTimeInterval(-3600))],
         "matchup": ["period": "Q3", "left": ["name": "A", "badge": "https://example.com/a.png", "score": 60], "right": ["name": "B", "score": "58"]],
         "why": ["kind": "team", "title": "A", "interest": "team:a"]],
        ["id": "games:2", "source": ["plugin": "games", "id": "2"], "title": "C vs D",
         "live": ["state": "upcoming", "startsAt": ms(now.addingTimeInterval(1800))],
         "matchup": ["left": ["name": "C"], "right": ["name": "D"]]],
      ]],
      ["id": "new", "role": "new", "items": [
        ["id": "web:x", "source": ["plugin": "web", "id": "x", "url": "https://example.com/x"], "title": "Fresh", "at": ms(now.addingTimeInterval(-3600)),
         "duration": 600, "resumeAt": 120, "why": ["kind": "channel", "title": "Chan", "interest": "channel:c"]],
        ["id": "web:y", "source": ["plugin": "web", "id": "y"], "title": "Older", "at": ms(now.addingTimeInterval(-72 * 3600)),
         "why": ["kind": "channel", "title": "Chan", "interest": "channel:c"]],
        ["title": "No source"],
      ]],
      ["id": "replays", "role": "replays", "items": [
        ["id": "games:3", "source": ["plugin": "games", "id": "3"], "title": "E vs F", "live": ["state": "ended"], "at": ms(now)],
      ]],
    ],
  ]

  @Test func cardsSayWhatIsOnWhatIsNewAndNeverHowAGameEnded() throws {
    let feed = Feed(json: Self.answer)
    #expect(feed.rows.map(\.role) == ["live", "new", "replays"])
    let game = try #require(feed.row("live").first)
    #expect(game.id == "games:1")
    #expect(game.item.playReference == ["source": ["plugin": "games", "id": "1"]])
    #expect(game.badge(now: Self.now) == .live)
    #expect(game.matchup?.score == "60 – 58")
    #expect(game.matchup?.period == "Q3")
    #expect(game.why == FeedItem.Why(kind: "team", title: "A", interest: "team:a"))
    let upcoming = feed.row("live")[1]
    #expect(upcoming.badge(now: Self.now) == .upcoming(Self.now.addingTimeInterval(1800)))
    #expect(upcoming.matchup?.score == "vs")

    // A card is new for 48 hours, keeps its progress, and one without a Source is dropped.
    #expect(feed.row("new").count == 2)
    #expect(feed.row("new")[0].badge(now: Self.now) == .new)
    #expect(feed.row("new")[0].item.progress == 0.2)
    #expect(feed.row("new")[1].badge(now: Self.now) == nil)
    // An ended game says nothing in its corner.
    #expect(feed.row("replays")[0].badge(now: Self.now) == nil)
  }

  @Test func theHomeAsksAgainSoonerWhileSomethingIsOnOrBeingRead() {
    let feed = Feed(json: Self.answer)
    #expect(feed.refreshAfter == .seconds(60))
    #expect(feed.without(interest: "team:a").without(feed.row("live")[1]).refreshAfter == .seconds(300))
    #expect(Feed(rows: [], reading: true).refreshAfter == .seconds(10))
  }

  @Test func notInterestedAndStopFollowingHideCardsAtOnce() throws {
    let feed = Feed(json: Self.answer)
    let fresh = feed.row("new")[0]
    #expect(feed.without(fresh).row("new").map(\.id) == ["web:y"])
    let unfollowed = feed.without(interest: "channel:c")
    #expect(unfollowed.rows.map(\.role) == ["live", "replays"])
  }

  @Test func feedbackTellsYoloAndAnOlderServerHasNoRows() async throws {
    let transport = StubTransport { request in
      request.url?.path == "/v1/feed/feedback" ? (200, ["ok": true]) : (404, ["error": ["code": "not_found", "message": "Not found"]])
    }
    let api = APIClient(address: server, credential: DeviceCredential(token: "ydt_t", deviceId: "tv"), transport: transport)
    #expect(try await api.feed().rows.isEmpty)
    let feed = Feed(json: Self.answer)
    try await api.notInterested(feed.row("new")[0])
    try await api.stopFollowing("channel:c")
    let bodies = transport.requests.filter { $0.httpMethod == "POST" }.map { $0.httpBody?.json ?? .null }
    #expect(bodies.count == 2)
    #expect(bodies[0]["signal"]?.string == "not_interested")
    #expect(bodies[0]["source"]?["id"]?.string == "x")
    #expect(bodies[1] == ["signal": "stop_following", "interest": "channel:c"])
  }
}
