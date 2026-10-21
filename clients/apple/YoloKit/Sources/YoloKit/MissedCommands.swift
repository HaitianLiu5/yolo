import Foundation

// What Yolo's Hub said to this screen that a reconnect lost, and what the
// owner did here meanwhile (Agent Note 2026-10-07-hub-and-realtime-channel,
// What a dead connection takes), as the player's `missed-commands.js`. The
// Hub sends each command once, over the connections the screen has then,
// and a connection that died without the Hub noticing takes it. The welcome
// after the reconnect names the last pause or resume and the last seek the
// Hub sent for the stream it names (`commands`, with their ids); what of
// that this screen never dealt with, it does now, unless the owner did the
// same kind of thing here and Yolo may not have heard it yet.

/// The last pause or resume and the last seek this screen dealt with for
/// one stream: heard live, or settled from a welcome whether done or left
/// out. A welcome naming one of them again changes nothing; a new stream
/// starts with none.
public struct SettledCommands: Sendable, Equatable {
  public enum Slot: Sendable { case playback, seek }

  private var sessionId: String?
  private var playback: String?
  private var seek: String?

  public init() {}

  public mutating func settle(_ sessionId: String?, _ slot: Slot, id: String?) {
    guard let sessionId, let id else { return }
    if self.sessionId != sessionId {
      self = SettledCommands()
      self.sessionId = sessionId
    }
    switch slot {
    case .playback: playback = id
    case .seek: seek = id
    }
  }

  public func has(_ sessionId: String, _ slot: Slot, id: String) -> Bool {
    guard self.sessionId == sessionId else { return false }
    return (slot == .playback ? playback : seek) == id
  }

  /// The welcome's commands for `sessionId`, done or left out now.
  public mutating func settleWelcome(_ commands: JSONValue?, sessionId: String?) {
    guard let sessionId, commands?["sessionId"]?.string == sessionId else { return }
    settle(sessionId, .playback, id: commands?["playback"]?["id"]?.string)
    settle(sessionId, .seek, id: commands?["seek"]?["id"]?.string)
  }
}

/// What the welcome's commands ask of the stream on screen.
public struct MissedCommands: Sendable, Equatable {
  public var pause = false
  public var resume = false
  /// A missed resume left out: the owner paused or left here unheard.
  public var resumeHeld = false
  public var seek: Double?
  /// A missed seek left out: the owner sought here unheard.
  public var seekHeld = false

  public static let none = MissedCommands()

  public init() {}

  /// The commands for the stream this screen plays that the welcome names
  /// and this screen never dealt with. A missed resume is left out when the
  /// owner paused here, or went Back, unheard: that pause may be the newer,
  /// and nothing starts playing on a doubt. A missed seek is left out when
  /// the owner sought here unheard. A missed pause always goes.
  public init(welcome: Welcome, deviceId: String?, sessionId: String?, settled: SettledCommands, own: Set<OwnAction> = []) {
    self.init()
    guard let state = welcome.state, let commands = welcome.commands, let deviceId, let sessionId,
          state["deviceId"]?.string == deviceId, state["sessionId"]?.string == sessionId,
          commands["sessionId"]?.string == sessionId
    else { return }
    func missed(_ slot: SettledCommands.Slot, _ key: String) -> Bool {
      guard let id = commands[key]?["id"]?.string else { return false }
      return !settled.has(sessionId, slot, id: id)
    }
    let playback = missed(.playback, "playback") ? commands["playback"]?["action"]?.string : nil
    pause = playback == "pause"
    resume = playback == "resume" && !own.contains(.playback)
    resumeHeld = playback == "resume" && own.contains(.playback)
    if missed(.seek, "seek"), let position = commands["seek"]?["position"]?.number, position >= 0 {
      seek = own.contains(.seek) ? nil : position
      seekHeld = own.contains(.seek)
    }
  }
}

/// What the owner did on this screen that Yolo hears through reports.
public enum OwnAction: Sendable, Hashable {
  /// A pause or Back.
  case playback
  case seek
}

/// What the owner did here that Yolo may not have heard. Each counts as
/// unheard until Yolo answers a ping the screen sent over its welcomed
/// connection after it (`RealtimeConnection.confirm`): that connection
/// delivers in order, so whatever Yolo sends from then on, or sent and the
/// screen has not received, was sent after it. No clock is read. One ping
/// is in flight at a time: its answer covers what came before it, and what
/// came after waits for the next. A welcome takes what is unheard; from it
/// on, everything Yolo sends over the new connection is newer.
@MainActor
public final class OwnActions {
  public typealias Confirm = @MainActor (_ heard: @escaping @Sendable () -> Void) async -> Bool

  private let confirm: Confirm
  private var unheard: [OwnAction: Int] = [:]
  private var count = 0
  private var welcomes = 0
  private var asking = false

  public init(confirm: @escaping Confirm) {
    self.confirm = confirm
  }

  public func note(_ action: OwnAction) {
    count += 1
    unheard[action] = count
    ask()
  }

  /// What is unheard now; nothing is unheard afterwards.
  public func take() -> Set<OwnAction> {
    let actions = Set(unheard.keys)
    unheard.removeAll()
    welcomes += 1
    asking = false
    return actions
  }

  public var isEmpty: Bool { unheard.isEmpty }

  private func ask() {
    guard !asking, !unheard.isEmpty else { return }
    let covers = count
    let welcome = welcomes
    asking = true
    Task { [weak self, confirm] in
      let sent = await confirm { [weak self] in
        Task { @MainActor in self?.answered(covers: covers, welcome: welcome) }
      }
      if !sent, let self, welcome == self.welcomes { self.asking = false }
    }
  }

  private func answered(covers: Int, welcome: Int) {
    guard welcome == welcomes else { return }
    asking = false
    unheard = unheard.filter { $0.value > covers }
    ask()
  }
}

/// A stream that played to its end here and told Yolo `ended`, until
/// anything plays, pauses, or seeks it or another stream starts. `heard`
/// once Yolo answered a ping sent after the `ended`. A welcome that still
/// names the stream while it is unheard gets `ended` again, so the queue
/// goes on as it would have.
public struct FinishedStream: Sendable, Equatable {
  public let sessionId: String
  public var heard = false

  public init(sessionId: String) {
    self.sessionId = sessionId
  }

  /// Whether a welcome that names `state` asks for `ended` again.
  public func sendsAgain(after welcome: Welcome, missed: MissedCommands) -> Bool {
    !heard && !missed.pause && missed.seek == nil && welcome.state?["sessionId"]?.string == sessionId
  }
}

/// A stream the owner left with Back, remembered until Yolo marks it left
/// (`leftAt`) or names another stream, and kept across launches, so an app
/// opened again does not play what the owner left. A welcome that still
/// names it on this device says `idle` again.
public struct LeftStream: Sendable, Equatable, Codable {
  public let sessionId: String
  public let position: Double

  public init(sessionId: String, position: Double) {
    self.sessionId = sessionId
    self.position = position
  }

  /// Whether Yolo has taken it: another device, another stream, or `leftAt`.
  public func settled(by state: JSONValue?, deviceId: String?) -> Bool {
    guard let state else { return true }
    return state["deviceId"]?.string != deviceId || state["sessionId"]?.string != sessionId
      || (state["leftAt"] != nil && state["leftAt"]?.isNull == false)
  }

  public var idleReport: PlaybackReport {
    PlaybackReport(sessionId: sessionId, status: .idle, position: position, duration: nil, playing: false)
  }
}
