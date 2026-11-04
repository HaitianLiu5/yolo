import Foundation
import Testing
@testable import YoloKit

@Suite struct QualityTests {
  static func sample(_ kbps: Double, buffer: Double, buffering: Bool = false) -> QualityController.Sample {
    .init(throughputKbps: kbps, sampleCount: 5, bufferedAhead: buffer, buffering: buffering, remaining: 1000)
  }

  static func loaded(videoKbps: Double = 6000, capped: Int? = nil) -> QualityController {
    var quality = QualityController()
    let limits: JSONValue = ["maxVideoKbps": capped.map { .number(Double($0)) } ?? .null, "ceilingKbps": 20000, "capped": .bool(capped != nil)]
    quality.load(limits: limits, profile: ["videoKbps": .number(videoKbps), "audioKbps": 128], isLive: false, item: "x", path: "lan", now: 0)
    return quality
  }

  @Test func aStallOfEightSecondsStepsDownToWhatTheConnectionCarries() {
    var quality = Self.loaded()
    #expect(quality.observe(Self.sample(3000, buffer: 2, buffering: true), now: 1) == .keep)
    // 3000 * 0.75 - 128 = 2122: the rung at or below is 1500.
    #expect(quality.observe(Self.sample(3000, buffer: 2, buffering: true), now: 9) == .change(maxVideoKbps: 1500))
    #expect(quality.requestCap == .some(1500))
  }

  @Test func aDrainingBufferStepsDownAfterTwentySecondsUnlessTheStreamAdapts() {
    var quality = Self.loaded()
    _ = quality.observe(Self.sample(5000, buffer: 10), now: 1)
    #expect(quality.observe(Self.sample(5000, buffer: 10), now: 15) == .keep)
    #expect(quality.observe(Self.sample(5000, buffer: 10), now: 21) == .change(maxVideoKbps: 3000))
    var adaptive = Self.loaded()
    var sample = Self.sample(5000, buffer: 10)
    sample.adaptive = true
    _ = adaptive.observe(sample, now: 1)
    #expect(adaptive.observe(sample, now: 30) == .keep)
  }

  @Test func aStepUpAfterNinetySecondsOfHeadroomIsKeptForTheNextStreamOnItsPath() {
    var quality = Self.loaded(videoKbps: 3000, capped: 3000)
    let plenty = Self.sample(20000, buffer: 40)
    #expect(quality.observe(plenty, now: 1) == .keep)
    #expect(quality.observe(plenty, now: 60) == .keep)
    // Never a new stream: the one that plays keeps its buffer.
    #expect(quality.observe(plenty, now: 92) == .kept(maxVideoKbps: 4000))
    #expect(quality.requestCap == .some(4000))
    #expect(quality.rate.map { "\($0.path) \($0.kbps ?? 0)" } == "lan 4000")
    // The next rung waits another ninety seconds, from the kept rate.
    #expect(quality.observe(plenty, now: 93) == .keep)
    #expect(quality.observe(plenty, now: 150) == .keep)
    #expect(quality.observe(plenty, now: 183) == .kept(maxVideoKbps: 6000))
    // The next stream starts there; its own cap now applies.
    quality.load(limits: ["maxVideoKbps": 6000, "ceilingKbps": 20000, "capped": true], profile: ["videoKbps": 6000], isLive: false, item: "x", path: "lan", now: 200)
    #expect(quality.rate == nil)
    #expect(quality.requestCap == .some(6000))
  }

  @Test func nearTheCeilingTheCapIsLifted() {
    var quality = Self.loaded(videoKbps: 13000, capped: 13000)
    let plenty = Self.sample(60000, buffer: 40)
    _ = quality.observe(plenty, now: 1)
    #expect(quality.observe(plenty, now: 95) == .kept(maxVideoKbps: nil))
    #expect(quality.requestCap == .some(nil))
    #expect(quality.rate.map { "\($0.path) \($0.kbps.map(String.init) ?? "none")" } == "lan none")
  }

  @Test func aStepDownDropsAKeptStepUp() {
    var quality = Self.loaded(videoKbps: 3000, capped: 3000)
    _ = quality.observe(Self.sample(20000, buffer: 40), now: 1)
    #expect(quality.observe(Self.sample(20000, buffer: 40), now: 92) == .kept(maxVideoKbps: 4000))
    _ = quality.observe(Self.sample(1500, buffer: 2, buffering: true), now: 100)
    // 1500 * 0.75 - 128 = 997: the rung at or below is 700.
    #expect(quality.observe(Self.sample(1500, buffer: 2, buffering: true), now: 108) == .change(maxVideoKbps: 700))
    #expect(quality.rate == nil)
    #expect(quality.requestCap == .some(700))
  }

  @Test func theOwnersChoiceHoldsUntilAutoAndOffersOnlyRungsUnderTheCeiling() {
    var quality = Self.loaded()
    #expect(quality.choices.last == 13000)
    quality.choose(.some(1500))
    #expect(quality.requestCap == .some(1500))
    // A stall no longer steps down: the owner chose this rate.
    _ = quality.observe(Self.sample(1000, buffer: 2, buffering: true), now: 1)
    #expect(quality.observe(Self.sample(1000, buffer: 2, buffering: true), now: 20) == .keep)
    quality.choose(.some(nil))
    #expect(quality.requestCap == .some(nil))
    quality.choose(nil)
    _ = quality.observe(Self.sample(3000, buffer: 2, buffering: true), now: 30)
    #expect(quality.observe(Self.sample(3000, buffer: 2, buffering: true), now: 39) == .change(maxVideoKbps: 1500))
    var low = QualityController()
    low.load(limits: ["maxVideoKbps": .null, "ceilingKbps": 4800, "capped": false], profile: ["videoKbps": 4000], isLive: false, item: "x", now: 0)
    #expect(low.choices.last == 4000)
  }

  @Test func unknownLimitsLeaveTheCapToTheHubAndLiveNeverAdapts() {
    #expect(QualityController().requestCap == nil)
    var live = QualityController()
    live.load(limits: nil, profile: ["videoKbps": 6000], isLive: true, item: "x", now: 0)
    #expect(live.observe(Self.sample(100, buffer: 0, buffering: true), now: 30) == .keep)
  }
}

@Suite struct AgentTests {
  @Test func readsAnAnswersLines() {
    #expect(AgentEvent(line: #"{"type":"conversation","id":"cnv_1","title":"Play Dune"}"#) == .conversation(id: "cnv_1", title: "Play Dune"))
    #expect(AgentEvent(line: #"{"type":"tool","name":"search"}"#) == .tool("search"))
    #expect(AgentEvent(line: #"{"type":"done","text":"Playing Dune.","agent":"claude-code","session":"s"}"#) == .done("Playing Dune."))
    #expect(AgentEvent(line: #"{"type":"error","error":{"code":"node_offline","message":"Media node is offline"}}"#) == .error("Media node is offline"))
    #expect(AgentEvent(line: "") == nil)
    #expect(AgentEvent.step(for: "play") == "Starting it…")
    #expect(AgentEvent.step(for: "mystery") == "Working on it…")
  }

  @Test func asksInANewConversationAndStreamsTheAnswer() async throws {
    let transport = StubTransport { request in
      #expect(request.url?.path == "/v1/agent/conversations/new/messages")
      #expect(request.jsonBody == ["text": "Play Dune", "language": "en-US"])
      return (200, nil)
    }
    // The stub answers JSON; give it NDJSON through a transport of its own.
    struct Lines: HTTPTransport {
      let inner: StubTransport
      func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (_, response) = try await inner.data(for: request)
        let body = [#"{"type":"conversation","id":"cnv_1","title":"Play Dune"}"#, "", #"{"type":"tool","name":"play"}"#, #"{"type":"done","text":"Playing."}"#].joined(separator: "\n")
        return (Data(body.utf8), response)
      }
    }
    let api = APIClient(address: server, credential: DeviceCredential(token: "t", deviceId: "tv"), transport: Lines(inner: transport))
    var events: [AgentEvent] = []
    for try await event in try await api.ask("Play Dune", in: nil, language: "en-US") { events.append(event) }
    #expect(events == [.conversation(id: "cnv_1", title: "Play Dune"), .tool("play"), .done("Playing.")])
  }
}

@Suite struct AudioTracksTests {
  @Test func readsTheAudioTracksAndWhichPlays() {
    let tracks = StreamTracks(json: [
      "subtitles": [],
      "audio": [["id": "plex:1", "name": "English (AAC Stereo)", "language": "en", "default": true], ["id": "plex:2", "name": "", "language": "ja"]],
      "selected": ["subtitles": [], "audio": nil],
    ])
    #expect(tracks.audio.map(\.label) == ["English (AAC Stereo)", "ja"])
    #expect(tracks.currentAudio == "plex:1")
    #expect(tracks.applying(tracks: nil, selected: ["subtitles": [], "audio": "plex:2"]).currentAudio == "plex:2")
  }
}
