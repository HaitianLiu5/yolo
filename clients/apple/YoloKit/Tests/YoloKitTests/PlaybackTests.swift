import Foundation
import Testing
@testable import YoloKit

@Suite struct LoadTests {
  static func load(_ fields: JSONValue) -> Load? {
    Load(RealtimeMessage(text: fields.encodedString())!)
  }

  @Test func readsTheStreamAndResolvesItsURLAgainstTheMediaOrigin() throws {
    let load = try #require(Self.load([
      "v": 1, "type": "load", "reason": "play", "startTime": 42.5, "autoplay": false,
      "item": ["title": "Film", "source": ["provider": "x", "id": "1"]],
      "stream": [
        "sessionId": "ses_1", "delivery": ["type": "hls", "url": "/m/tok/master.m3u8"],
        "origin": "https://lan.example.com:8443", "title": "Film", "duration": 5400, "isLive": false, "startTime": 40,
      ],
    ]))
    #expect(load.stream.sessionId == "ses_1")
    #expect(load.startTime == 42.5)
    #expect(load.autoplay == false)
    #expect(load.reason == "play")
    #expect(load.stream.mediaURL(server: server)?.absoluteString == "https://lan.example.com:8443/m/tok/master.m3u8")
  }

  @Test func theRelayResolvesAgainstTheServerAndStartsWhereTheStreamDoes() throws {
    let load = try #require(Self.load([
      "v": 1, "type": "load",
      "stream": ["sessionId": "ses_2", "delivery": ["type": "mp4", "url": "/m/tok/file.mp4"], "origin": nil, "startTime": 12],
    ]))
    #expect(load.startTime == 12)
    #expect(load.autoplay)
    #expect(load.stream.mediaURL(server: server)?.absoluteString == "https://yolo.example.com/m/tok/file.mp4")
  }

  @Test func aSplitDeliveryIsNotOneThisClientOpens() throws {
    let load = try #require(Self.load([
      "v": 1, "type": "load",
      "stream": ["sessionId": "ses_3", "delivery": ["type": "split-mp4", "videoUrl": "/m/t/v.mp4", "audioUrl": "/m/t/a.mp4"]],
    ]))
    #expect(load.stream.mediaURL(server: server) == nil)
  }
}

@Suite struct PlaybackCommandTests {
  static func command(_ fields: JSONValue) -> PlaybackCommand? {
    PlaybackCommand(RealtimeMessage(text: fields.encodedString())!)
  }

  @Test func readsTheCommands() {
    #expect(Self.command(["v": 1, "type": "pause", "id": "c1", "sessionId": "s1"]) == .pause(sessionId: "s1"))
    #expect(Self.command(["v": 1, "type": "seek", "id": "c2", "sessionId": "s1", "position": 90]) == .seek(sessionId: "s1", position: 90))
    #expect(Self.command(["v": 1, "type": "deactivate", "reason": "replaced"]) == .deactivate)
    // Another screen's play never stops this one on protocol 2.
    #expect(Self.command(["v": 1, "type": "deactivate", "reason": "moved"]) == nil)
    #expect(Self.command(["v": 1, "type": "state"]) == nil)
  }

  @Test func aPauseAlwaysGoesButAResumeOrSeekAheadOfAWelcomeOnlyForTheStreamOnScreen() {
    #expect(PlaybackCommand.pause(sessionId: "old").applies(to: "new", welcomed: false))
    #expect(PlaybackCommand.resume(sessionId: "new").applies(to: "new", welcomed: false))
    #expect(!PlaybackCommand.resume(sessionId: "old").applies(to: "new", welcomed: false))
    #expect(!PlaybackCommand.seek(sessionId: "old", position: 5).applies(to: "new", welcomed: false))
    #expect(PlaybackCommand.seek(sessionId: nil, position: 5).applies(to: "new", welcomed: false))
    // Over a welcomed connection a stream's load came first: they go.
    #expect(PlaybackCommand.seek(sessionId: "next", position: 5).applies(to: "new", welcomed: true))
  }
}

@Suite struct ReportTests {
  @Test func theReportCarriesWhatTheHubReads() {
    let report = PlaybackReport(sessionId: "s1", status: .playing, position: 12.34567, duration: 5400, playing: true, viewport: (3840, 2160))
    #expect(JSONValue.object(report.fields) == [
      "sessionId": "s1", "status": "playing", "position": 12.346, "duration": 5400, "playing": true,
      "viewport": ["width": 3840, "height": 2160, "devicePixelRatio": 1],
    ])
    let live = PlaybackReport(sessionId: "s1", status: .buffering, position: 1, duration: nil, playing: false)
    #expect(live.fields["duration"] == .null)
  }

  @Test func aChangeGoesAtOnceAndRepeatsWaitFiveSeconds() {
    var pacer = ReportPacer()
    let start = ContinuousClock.now
    let playing = PlaybackReport(sessionId: "s1", status: .playing, position: 1, duration: 10, playing: true)
    #expect(pacer.due(playing, at: start))
    pacer.sent(playing, at: start)
    #expect(!pacer.due(playing, at: start + .seconds(4)))
    #expect(pacer.due(playing, at: start + .seconds(5)))
    let paused = PlaybackReport(sessionId: "s1", status: .paused, position: 1, duration: 10, playing: false)
    #expect(!pacer.due(paused, at: start + .milliseconds(500)))
    #expect(pacer.due(paused, at: start + .milliseconds(800)))
    #expect(pacer.due(paused, at: start + .milliseconds(100), force: true))
    let next = PlaybackReport(sessionId: "s2", status: .playing, position: 0, duration: 10, playing: true)
    #expect(pacer.due(next, at: start + .milliseconds(100)))
  }
}

@Suite struct RecoveryRequestTests {
  static let state: JSONValue = [
    "status": "playing", "deviceId": "tv", "sessionId": "ses_9", "position": 100, "positionAt": 1_000_000,
    "item": ["source": ["provider": "x", "id": "1"], "duration": 5400],
  ]

  @Test func aWelcomeThatStillNamesThisDevicePlayingAsksForTheStreamWhereYoloIs() throws {
    let request = try #require(RecoveryRequest(welcomeState: Self.state, deviceId: "tv", playing: nil, network: .lan, now: Date(timeIntervalSince1970: 1_030)))
    #expect(request.body == [
      "source": ["provider": "x", "id": "1"], "startTime": 130, "reason": "recovery", "autoplay": true,
      "sessionId": "ses_9", "deviceId": "tv", "network": "lan",
    ])
  }

  @Test func nothingToRecoverForAnotherDeviceTheStreamOnScreenOrAnItemLeftByBack() {
    #expect(RecoveryRequest(welcomeState: Self.state, deviceId: "car", playing: nil, network: .lan) == nil)
    #expect(RecoveryRequest(welcomeState: Self.state, deviceId: "tv", playing: "ses_9", network: .lan) == nil)
    var left = Self.state.object!
    left["leftAt"] = 1_000
    #expect(RecoveryRequest(welcomeState: .object(left), deviceId: "tv", playing: nil, network: .lan) == nil)
    var idle = Self.state.object!
    idle["status"] = "idle"
    #expect(RecoveryRequest(welcomeState: .object(idle), deviceId: "tv", playing: nil, network: .lan) == nil)
    // Another screen continued it: it waits here paused, not resumed.
    var handed = Self.state.object!
    handed["handedTo"] = ["deviceId": "phone", "at": 1_000]
    #expect(RecoveryRequest(welcomeState: .object(handed), deviceId: "tv", playing: nil, network: .lan) == nil)
  }

  @Test func aPausedStreamComesBackPausedWhereItWas() throws {
    var paused = Self.state.object!
    paused["status"] = "paused"
    let request = try #require(RecoveryRequest(welcomeState: .object(paused), deviceId: "tv", playing: nil, network: nil, now: Date(timeIntervalSince1970: 1_030)))
    #expect(request.body["startTime"] == 100)
    #expect(request.body["autoplay"] == false)
    #expect(request.body["network"] == .null)
  }
}

@Suite struct StreamTimelineTests {
  @Test func aTranscodeResumedPartWayBeginsWhereTheItemLacksIt() {
    // A 4039 s item resumed at 519 s: the stream is 3521 s long.
    let timeline = StreamTimeline(trimToStart: true, itemDuration: 4039, streamDuration: 3521, startTime: 519, isLive: false)
    #expect(timeline.offset == 518)
    #expect(timeline.itemTime(5) == 523)
    #expect(timeline.streamTime(519) == 1)
    #expect(timeline.streamTime(100) == nil)
  }

  @Test func onlyATrimmedStreamThatLacksAboutItsStartIsOffset() {
    #expect(StreamTimeline(trimToStart: false, itemDuration: 4039, streamDuration: 3521, startTime: 519, isLive: false).offset == 0)
    #expect(StreamTimeline(trimToStart: true, itemDuration: 4039, streamDuration: 3521, startTime: 519, isLive: true).offset == 0)
    // Shorter than its item by more than the start: not a trim.
    #expect(StreamTimeline(trimToStart: true, itemDuration: 4039, streamDuration: 3000, startTime: 519, isLive: false).offset == 0)
    // A start well past the gap: not this trim either.
    #expect(StreamTimeline(trimToStart: true, itemDuration: 4039, streamDuration: 4000, startTime: 519, isLive: false).offset == 0)
    #expect(StreamTimeline(trimToStart: true, itemDuration: 4039, streamDuration: 4039, startTime: 519, isLive: false).offset == 0)
  }
}
