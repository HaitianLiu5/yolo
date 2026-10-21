import Foundation
import Testing
@testable import YoloKit

@Suite struct MissedCommandsTests {
  static func welcome(commands: JSONValue, state: JSONValue = ["deviceId": "tv", "sessionId": "s1", "status": "playing"]) -> Welcome {
    Welcome(RealtimeMessage(text: JSONValue.object(["v": 1, "type": "welcome", "deviceId": "tv", "state": state, "commands": commands]).encodedString())!)!
  }

  static let both: JSONValue = ["sessionId": "s1", "playback": ["id": "c1", "action": "pause"], "seek": ["id": "c2", "position": 300]]

  @Test func whatTheScreenNeverDealtWithItDoesNow() {
    let missed = MissedCommands(welcome: Self.welcome(commands: Self.both), deviceId: "tv", sessionId: "s1", settled: SettledCommands())
    #expect(missed.pause)
    #expect(missed.seek == 300)
  }

  @Test func whatItHeardLiveOrFromAnEarlierWelcomeChangesNothing() {
    var settled = SettledCommands()
    settled.settle("s1", .playback, id: "c1")
    settled.settle("s1", .seek, id: "c2")
    #expect(MissedCommands(welcome: Self.welcome(commands: Self.both), deviceId: "tv", sessionId: "s1", settled: settled) == .none)
    var fromWelcome = SettledCommands()
    fromWelcome.settleWelcome(Self.both, sessionId: "s1")
    #expect(MissedCommands(welcome: Self.welcome(commands: Self.both), deviceId: "tv", sessionId: "s1", settled: fromWelcome) == .none)
  }

  @Test func aNewStreamStartsWithNoneSettled() {
    var settled = SettledCommands()
    settled.settle("s0", .playback, id: "c1")
    settled.settle("s1", .seek, id: "c2")
    #expect(!settled.has("s0", .playback, id: "c1"))
    #expect(settled.has("s1", .seek, id: "c2"))
  }

  @Test func theOwnersUnheardPauseHoldsAMissedResumeAndTheirSeekAMissedSeek() {
    let commands: JSONValue = ["sessionId": "s1", "playback": ["id": "c1", "action": "resume"], "seek": ["id": "c2", "position": 300]]
    let missed = MissedCommands(welcome: Self.welcome(commands: commands), deviceId: "tv", sessionId: "s1", settled: SettledCommands(), own: [.playback, .seek])
    #expect(!missed.resume)
    #expect(missed.resumeHeld)
    #expect(missed.seek == nil)
    #expect(missed.seekHeld)
    let pause = MissedCommands(welcome: Self.welcome(commands: Self.both), deviceId: "tv", sessionId: "s1", settled: SettledCommands(), own: [.playback])
    #expect(pause.pause)
  }

  @Test func onlyForTheStreamThisDevicePlays() {
    #expect(MissedCommands(welcome: Self.welcome(commands: Self.both), deviceId: "tv", sessionId: "s2", settled: SettledCommands()) == .none)
    let elsewhere = Self.welcome(commands: Self.both, state: ["deviceId": "car", "sessionId": "s1"])
    #expect(MissedCommands(welcome: elsewhere, deviceId: "tv", sessionId: "s1", settled: SettledCommands()) == .none)
  }

  @Test func anUnheardEndedGoesAgainUnlessAMissedPauseOrSeekMovedIt() {
    let welcome = Self.welcome(commands: [:])
    var finished = FinishedStream(sessionId: "s1")
    #expect(finished.sendsAgain(after: welcome, missed: .none))
    var paused = MissedCommands.none
    paused.pause = true
    #expect(!finished.sendsAgain(after: welcome, missed: paused))
    finished.heard = true
    #expect(!finished.sendsAgain(after: welcome, missed: .none))
  }

  @Test func aLeftStreamIsSettledOnceYoloMarksItLeftOrMovesOn() {
    let left = LeftStream(sessionId: "s1", position: 42)
    #expect(!left.settled(by: ["deviceId": "tv", "sessionId": "s1", "status": "paused"], deviceId: "tv"))
    #expect(left.settled(by: ["deviceId": "tv", "sessionId": "s1", "leftAt": 1], deviceId: "tv"))
    #expect(left.settled(by: ["deviceId": "tv", "sessionId": "s2"], deviceId: "tv"))
    #expect(left.idleReport.fields["status"] == "idle")
    #expect(left.idleReport.fields["position"] == 42)
  }
}

@MainActor @Suite struct OwnActionsTests {
  /// Pings that the test answers by hand, in order.
  @MainActor final class Pinger {
    var pending: [@Sendable () -> Void] = []
    var welcomed = true

    func confirm(_ heard: @escaping @Sendable () -> Void) async -> Bool {
      guard welcomed else { return false }
      pending.append(heard)
      return true
    }

    func answer() {
      pending.removeFirst()()
    }
  }

  @Test func anActionIsUnheardUntilYoloAnswersAPingSentAfterIt() async {
    let pinger = Pinger()
    let own = OwnActions(confirm: pinger.confirm)
    own.note(.playback)
    #expect(await eventually { @MainActor in pinger.pending.count == 1 })
    own.note(.seek) // after the ping: waits for the next one
    pinger.answer()
    #expect(await eventually { @MainActor in pinger.pending.count == 1 })
    #expect(!own.isEmpty)
    pinger.answer()
    #expect(await eventually { @MainActor in own.isEmpty })
  }

  @Test func withoutAWelcomedConnectionItStaysUnheardUntilTheWelcomeTakesIt() async {
    let pinger = Pinger()
    pinger.welcomed = false
    let own = OwnActions(confirm: pinger.confirm)
    own.note(.playback)
    try? await Task.sleep(for: .milliseconds(20))
    #expect(own.take() == Set<OwnAction>([.playback]))
    #expect(own.isEmpty)
  }
}

@Suite struct HealthTests {
  @Test func healthRidesOnTheReportInTheHubsShape() {
    var health = PlaybackHealth()
    health.bufferSeconds = 12.34
    health.throughputKbps = 18_432.6
    health.stalls = 1
    health.stallSeconds = 2.25
    health.recentStalls = [(ago: 30, seconds: 2.25)]
    health.width = 3840
    health.height = 2160
    health.droppedFrames = 3
    let report = PlaybackReport(sessionId: "s1", status: .playing, position: 1, duration: 10, playing: true, health: health)
    #expect(report.fields["health"] == [
      "engine": "native", "bufferSeconds": 12.3, "throughputKbps": 18433, "buffering": false, "stalls": 1, "stallSeconds": 2.3,
      "recentStalls": [["ago": 30, "seconds": 2.3]], "width": 3840, "height": 2160, "videoCodec": nil, "droppedFrames": 3,
    ])
  }

  @Test func onceAStreamStallOrBufferingChangeElseEveryFifteenSeconds() {
    var pacer = HealthPacer()
    let start = ContinuousClock.now
    func take(_ session: String, _ stalls: Int, _ buffering: Bool, _ seconds: Int) -> Bool {
      pacer.take(sessionId: session, stalls: stalls, buffering: buffering, at: start + .seconds(seconds))
    }
    let taken = [
      take("s1", 0, false, 0), take("s1", 0, false, 5), take("s1", 0, true, 6), take("s1", 1, true, 7),
      take("s1", 1, true, 20), take("s1", 1, true, 22), take("s2", 0, false, 23),
    ]
    #expect(taken == [true, false, true, true, false, true, true])
  }

  @Test func stallsCountTheirTimeAndTheRecentOnesNewestFirst() {
    var stalls = StallCounter()
    let start = ContinuousClock.now
    stalls.stalled(at: start)
    stalls.resumed(at: start + .seconds(2))
    stalls.stalled(at: start + .seconds(10))
    #expect(stalls.count == 2)
    #expect(stalls.isStalled)
    #expect(stalls.seconds(at: start + .seconds(11)) == 3)
    let recent = stalls.recent(at: start + .seconds(11))
    #expect(recent.map(\.ago) == [1, 11])
    #expect(recent.map(\.seconds) == [1, 2])
  }
}
