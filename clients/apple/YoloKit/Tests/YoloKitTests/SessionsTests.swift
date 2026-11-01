import Foundation
import Testing
@testable import YoloKit

// Client protocol 2: every screen's own session (Agent Note
// 2026-10-31-screen-sessions).
@Suite struct SessionsTests {
  static let now = Date(timeIntervalSince1970: 2_000_000)
  static func ms(_ seconds: Double) -> JSONValue { .number(seconds * 1000) }

  static func session(_ device: String, status: String = "paused", profile: String = "owner", at updated: Double, position: Double = 100, duration: Double = 3600, fields: [String: JSONValue] = [:]) -> JSONValue {
    var state: [String: JSONValue] = [
      "deviceId": .string(device), "sessionId": .string("ses_\(device)"), "status": .string(status), "position": .number(position),
      "positionAt": ms(updated), "updatedAt": ms(updated),
      "item": ["title": .string("On \(device)"), "duration": .number(duration), "source": ["plugin": "library", "id": .string(device)]],
      "profile": ["id": .string(profile), "name": .string(profile == "owner" ? "Me" : "Family")],
    ]
    state.merge(fields) { $1 }
    return .object(state)
  }

  static func welcome(state: JSONValue = ["status": "idle", "deviceId": nil], sessions: [JSONValue], profile: String = "owner") -> Welcome {
    Welcome(RealtimeMessage(text: JSONValue.object([
      "v": 1, "type": "welcome", "deviceId": "tv", "state": state, "sessions": .array(sessions),
      "profile": ["id": .string(profile), "name": "x"],
      "profiles": [["id": "owner", "name": "Me"], ["id": "family", "name": "Family"]],
    ]).encodedString())!)!
  }

  @Test func theHelloNamesProtocolTwo() throws {
    let hello = try JSONValue.parse(Hello(name: "TV", capabilities: .appleTV(maxHeight: 2160, decodesHEVC: true)).encoded())
    #expect(hello["protocol"] == 2)
  }

  @Test func continueOffersTheOwnersAndThisProfilesSessionsNewestFirstAndNotFinishedOnes() {
    var sessions = Sessions()
    sessions.welcome(Self.welcome(sessions: [
      Self.session("car", at: 1_000_000),
      Self.session("phone", status: "playing", at: 1_999_000),
      Self.session("bedroom", profile: "family", at: 1_999_500),
      Self.session("laptop", at: 1_999_900, position: 3590),
      Self.session("tv", at: 1_999_999),
    ]))
    #expect(sessions.continueCandidates().map(\.deviceId) == ["phone", "car"])
    #expect(sessions.profiles.map(\.id) == ["owner", "family"])

    // A family screen also offers the family's.
    var family = Sessions()
    family.welcome(Self.welcome(sessions: [Self.session("car", at: 1_000_000), Self.session("bedroom", profile: "family", at: 1_999_500)], profile: "family"))
    #expect(family.continueCandidates().map(\.deviceId) == ["bedroom", "car"])
  }

  @Test func statesAreReadByWhoseSessionTheyAre() {
    var sessions = Sessions()
    sessions.welcome(Self.welcome(sessions: []))
    #expect(sessions.state(Self.session("phone", status: "playing", at: 1_999_000)) == false)
    #expect(sessions.continueCandidates().map(\.deviceId) == ["phone"])
    #expect(sessions.own == nil)
    #expect(sessions.state(Self.session("tv", status: "playing", at: 1_999_000)) == true)
    #expect(sessions.own?.sessionId == "ses_tv")
    // The phone stopped: it is no longer offered.
    #expect(sessions.state(["deviceId": "phone", "status": "idle", "item": nil]) == false)
    #expect(sessions.continueCandidates().isEmpty)
  }

  @Test func theScreenThatContinuedThisOneComesFirst() {
    var sessions = Sessions()
    let handed = Self.session("tv", at: 1_999_000, fields: ["handedTo": ["deviceId": "car", "at": 1]])
    sessions.welcome(Self.welcome(state: handed, sessions: [Self.session("car", at: 1_000_000), Self.session("phone", at: 1_999_500)]))
    #expect(sessions.own?.handedTo == "car")
    #expect(sessions.continueCandidates().map(\.deviceId) == ["car", "phone"])
  }

  @Test func inUseIsPlayingOrPausedWithinHalfAnHourOnAScreenOnline() {
    let paused = ScreenSession(json: Self.session("phone", at: Self.now.timeIntervalSince1970 - 600))!
    #expect(paused.inUse(online: true, now: Self.now))
    #expect(!paused.inUse(online: false, now: Self.now))
    let old = ScreenSession(json: Self.session("phone", at: Self.now.timeIntervalSince1970 - 3600))!
    #expect(!old.inUse(online: true, now: Self.now))
    let handed = ScreenSession(json: Self.session("phone", status: "playing", at: 0, fields: ["handedTo": ["deviceId": "tv"]]))!
    #expect(!handed.inUse(online: true, now: Self.now))
  }

  @Test func aPlayingSessionsPositionMovesOnFromItsLastReport() {
    let playing = ScreenSession(json: Self.session("phone", status: "playing", at: Self.now.timeIntervalSince1970 - 30))!
    #expect(playing.livePosition(at: Self.now) == 130)
  }

  @Test func devicesSetWhoWatchesHereAndWhereAMoveCanGo() {
    var sessions = Sessions()
    sessions.welcome(Self.welcome(sessions: [Self.session("gone", at: 1)]))
    sessions.devices([
      ["id": "tv", "name": "Living room", "kind": "tv", "online": true, "profile": "family"],
      ["id": "phone", "name": "Phone", "kind": "phone", "online": true, "profile": "owner"],
      ["id": "car", "name": "Car", "kind": "car", "online": false],
      ["id": "remote", "name": "Remote", "kind": "phone", "online": true, "capabilities": ["renderer": "remote"]],
    ], profiles: [["id": "owner", "name": "Me"], ["id": "family", "name": "Family"]])
    #expect(sessions.profile?.name == "Family")
    #expect(sessions.moveTargets.map(\.id) == ["phone"])
    #expect(sessions.continueCandidates().isEmpty, "a removed screen's session goes")
  }

  @Test func aBusyScreenSaysWhoIsWatchingWhat() {
    let error = YoloAPIError(code: "screen_busy", message: "", status: 409, details: [
      "deviceId": "tv", "name": "Living room TV", "profile": ["id": "family", "name": "Family"], "item": ["title": "Film"],
    ])
    #expect(BusyScreen(error)?.question == "Family is watching Film on Living room TV.")
    #expect(BusyScreen(YoloAPIError(code: "superseded", message: "", status: 409)) == nil)
  }

  @Test func continuingAndMovingAreOneCallThatAsksAgainWithReplace() async throws {
    let transport = StubTransport { request in
      let body = request.jsonBody
      if body?["replace"] == nil, body?["deviceId"] == "tv" {
        return (409, ["error": ["code": "screen_busy", "message": "busy", "details": ["deviceId": "tv", "name": "TV"]]])
      }
      return (200, ["state": [:]])
    }
    let api = APIClient(address: server, credential: DeviceCredential(token: "ydt", deviceId: "phone"), transport: transport)
    try await api.transfer(to: "phone", from: "car")
    await #expect(throws: YoloAPIError.self) { try await api.transfer(to: "tv", from: "phone") }
    try await api.transfer(to: "tv", from: "phone", replace: true)
    let sent = transport.requests
    #expect(sent.map(\.httpMethod) == ["PUT", "PUT", "PUT"])
    #expect(sent.allSatisfy { $0.url?.path == "/v1/playback/device" })
    #expect(sent.map(\.jsonBody) == [
      ["deviceId": "phone", "from": "car"], ["deviceId": "tv", "from": "phone"], ["deviceId": "tv", "from": "phone", "replace": true],
    ])
    #expect(sent[0].value(forHTTPHeaderField: ClientProtocol.header) == "2")
  }
}
