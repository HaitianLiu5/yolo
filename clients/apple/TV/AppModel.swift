import Foundation
import Observation
import os
import YoloKit

/// What the app shows and the work behind each screen: finding the owner's
/// server, pairing, and staying on the realtime channel once paired.
@MainActor @Observable
final class AppModel {
  /// What the realtime channel made this screen do: `log stream --predicate
  /// 'subsystem == "dev.yolo.tv"'` on the Mac shows it.
  static let log = Logger(subsystem: "dev.yolo.tv", category: "realtime")

  enum Screen: Equatable {
    case starting
    case findServer(error: String?)
    /// A server Bonjour found, shown in full for the owner to confirm before
    /// pairing (Agent Note 2026-10-19-client-protocol, Discovery).
    case confirm(DiscoveredServer)
    case checking(ServerAddress)
    case pairing(ServerAddress)
    case updateClient(ServerAddress)
    case updateServer(ServerAddress)
    case ready
  }

  private(set) var screen: Screen = .starting
  private(set) var discovered: [DiscoveredServer] = []
  private(set) var pairingCode: DeviceCode?
  private(set) var pairingStatus = ""
  private(set) var paired: PairedServer?
  private(set) var realtimeStatus: RealtimeStatus = .offline
  private(set) var mediaPath: MediaPathChoice?
  /// The Hub's playback status for the owner's screens, from the latest
  /// welcome or `state` broadcast.
  private(set) var playback: String?
  let player = TVPlayer()
  /// The home screen's rows, once paired.
  private(set) var browser: Browser?
  private(set) var artwork: ArtworkLoader?
  /// What a press asked to play, until its `load` arrives.
  private(set) var starting: String?
  var playError: String?

  private let store: any PairingStore
  /// The last pause or resume and seek dealt with for the stream on screen.
  private var settled = SettledCommands()
  /// What the owner did here that Yolo may not have heard.
  private var ownActions: OwnActions?
  /// A stream the owner left with Back that Yolo may not have heard left,
  /// kept across launches.
  private var leftStream: LeftStream? {
    didSet { LeftStreamDefaults.save(leftStream) }
  }
  private var browsing: Task<Void, Never>?
  private var pairing: Task<Void, Never>?
  private var listening: Task<Void, Never>?
  private var realtime: RealtimeConnection?

  init(store: any PairingStore = KeychainPairingStore()) {
    self.store = store
    leftStream = LeftStreamDefaults.load()
  }

  func launch() {
    guard screen == .starting else { return }
    if let paired = store.load() {
      Task { await resume(paired) }
    } else {
      findServer()
    }
  }

  // MARK: Finding the server

  func findServer(error: String? = nil) {
    screen = .findServer(error: error)
    guard browsing == nil else { return }
    browsing = Task {
      for await servers in Bonjour.servers() {
        discovered = servers
      }
    }
  }

  private func stopBrowsing() {
    browsing?.cancel()
    browsing = nil
  }

  func choose(_ server: DiscoveredServer) {
    screen = .confirm(server)
  }

  /// An address the owner typed: explicit already, so it is checked at once.
  func connect(typed text: String) {
    guard let address = ServerAddress(text) else {
      findServer(error: "Type your Yolo's address, such as yolo.example.com.")
      return
    }
    Task { await check(address) }
  }

  func confirm(_ server: DiscoveredServer) {
    Task { await check(server.address) }
  }

  private func check(_ address: ServerAddress) async {
    screen = .checking(address)
    do {
      switch try await Discovery.check(address) {
      case .ready: startPairing(address)
      case .updateClient: screen = .updateClient(address)
      case .updateServer: screen = .updateServer(address)
      case .notYolo: findServer(error: "\(address.host) is not a Yolo server.")
      }
    } catch {
      findServer(error: "Cannot reach \(address.host): \(error.localizedDescription)")
    }
  }

  // MARK: Pairing

  private func startPairing(_ address: ServerAddress) {
    stopBrowsing()
    screen = .pairing(address)
    pairingCode = nil
    pairingStatus = "Asking Yolo for a code…"
    let client = PairingClient(address: address, deviceName: ThisDevice.name)
    pairing = Task {
      do {
        let credential = try await client.pair { event in await self.show(event) }
        let paired = PairedServer(address: address, credential: credential)
        do {
          try store.save(paired)
        } catch {
          pairingStatus = "Paired, but this Apple TV could not keep the credential (\(error))."
          return
        }
        start(paired)
      } catch {
        // Cancelled: the owner went back.
      }
    }
  }

  private func show(_ event: PairingEvent) {
    switch event {
    case .code(let code):
      pairingCode = code
      pairingStatus = "Scan the code with your phone and allow this Apple TV."
    case .unreachable(let message):
      pairingStatus = "Cannot reach Yolo (\(message)). Trying again…"
    case .refused(let message):
      pairingStatus = "\(message). Trying again…"
    case .denied:
      pairingStatus = "This Apple TV was denied. A new code follows shortly."
    }
  }

  func cancelPairing() {
    pairing?.cancel()
    pairing = nil
    findServer()
  }

  // MARK: Paired

  /// A paired app checks the server's protocols at each start, so an
  /// update is asked for before anything plays.
  private func resume(_ paired: PairedServer) async {
    switch try? await Discovery.check(paired.address) {
    case .updateClient: screen = .updateClient(paired.address)
    case .updateServer: screen = .updateServer(paired.address)
    default: start(paired)
    }
  }

  private func start(_ paired: PairedServer) {
    self.paired = paired
    let api = APIClient(address: paired.address, credential: paired.credential)
    browser = Browser(api: api)
    artwork = ArtworkLoader(api: api)
    screen = .ready
    let connection = RealtimeConnection(
      api: APIClient(address: paired.address, credential: paired.credential),
      hello: { await ThisDevice.hello() }
    )
    realtime = connection
    player.send = { type, fields in
      Task { await connection.send(type, fields) }
    }
    let confirm: OwnActions.Confirm = { heard in await connection.confirm(heard) }
    let own = OwnActions(confirm: confirm)
    ownActions = own
    player.onOwnAction = { action in own.note(action) }
    player.confirm = { heard in await connection.confirm(heard) }
    listening = Task {
      await connection.start()
      for await event in connection.events {
        await handle(event, from: connection)
      }
    }
  }

  private func handle(_ event: RealtimeEvent, from connection: RealtimeConnection) async {
    switch event {
    case .status(let status):
      realtimeStatus = status
    case .message(let message, let welcomed):
      if let welcome = Welcome(message) {
        await self.welcomed(welcome, on: connection)
      } else if let load = Load(message) {
        leftStream = nil
        starting = nil
        start(load)
      } else if let command = PlaybackCommand(message) {
        apply(command, id: message.id, welcomed: welcomed)
      } else if message.type == "state" {
        playback = message["state"]?["status"]?.string
        if let left = leftStream, left.settled(by: message["state"], deviceId: await connection.deviceId) { leftStream = nil }
      } else if message.type == "media", let media = message["media"] {
        await chooseMediaPath(MediaInfo(json: media), on: connection, announce: false)
      }
    case .upgradeRequired:
      if let paired { screen = .updateClient(paired.address) }
      await connection.stop()
    case .revoked:
      unpair()
    }
  }

  private func start(_ load: Load) {
    guard let paired, let url = load.stream.mediaURL(server: paired.address) else {
      player.send("error", [
        "sessionId": .string(load.stream.sessionId), "code": "UNSUPPORTED_DELIVERY",
        "message": .string("Apple TV cannot open a \(load.stream.deliveryType) stream"),
      ])
      return
    }
    player.start(load, url: url)
  }

  /// A live command. Its id settles it for the stream it names, whatever the
  /// screen shows when it arrives, so a welcome naming it again changes
  /// nothing.
  private func apply(_ command: PlaybackCommand, id: String?, welcomed: Bool) {
    let stream = command.stream(onScreen: player.sessionId)
    switch command {
    case .pause, .resume: settled.settle(stream, .playback, id: id)
    case .seek: settled.settle(stream, .seek, id: id)
    case .stop, .deactivate: break
    }
    guard command.applies(to: player.sessionId, welcomed: welcomed) else {
      Self.log.info("command \(String(describing: command), privacy: .public) left for another stream")
      return
    }
    Self.log.info("command \(String(describing: command), privacy: .public)")
    switch command {
    case .pause: player.pause()
    case .resume: player.resume()
    case .seek(_, let position): seek(to: position)
    case .stop, .deactivate: player.stop(reportIdle: false)
    }
  }

  private func seek(to position: Double) {
    if !player.seek(to: position) { Task { await requestStream(at: position) } }
  }

  /// A welcome: the reconnect may have lost commands Yolo sent this screen
  /// and reports this screen sent Yolo (Agent Note
  /// 2026-10-07-hub-and-realtime-channel, What a dead connection takes).
  /// Read against what the owner did here unheard, the welcome's commands
  /// for the stream on screen are done or left out, and settled either way;
  /// from this welcome on, what Yolo sends is newer than anything the owner
  /// did before it.
  private func welcomed(_ welcome: Welcome, on connection: RealtimeConnection) async {
    let deviceId = await connection.deviceId
    let own = ownActions?.take() ?? []
    let onScreen = player.sessionId
    let missed = MissedCommands(welcome: welcome, deviceId: deviceId, sessionId: onScreen, settled: settled, own: own)
    settled.settleWelcome(welcome.commands, sessionId: onScreen)
    Self.log.info("welcome missed: \(String(describing: missed), privacy: .public) own: \(String(describing: own), privacy: .public)")
    playback = welcome.state?["status"]?.string
    if let media = welcome.media { await chooseMediaPath(media, on: connection, announce: true) }

    // Left with Back: say `idle` again while Yolo still has it here.
    if let left = leftStream {
      if left.settled(by: welcome.state, deviceId: deviceId) {
        leftStream = nil
      } else if player.current == nil {
        await connection.send("report", left.idleReport.fields)
        return
      }
    }
    guard let load = player.current else {
      await recover(welcome, deviceId: deviceId)
      return
    }
    let state = welcome.state
    // Yolo moved playback elsewhere or stopped it while offline.
    guard state?["deviceId"]?.string == deviceId, let hubStream = state?["sessionId"]?.string else {
      player.stop(reportIdle: false)
      return
    }
    // Yolo has another stream for this screen: its `load` went with the old
    // connection. Ask for it in place of the one on screen; only if that
    // fails does the screen leave its stream.
    if hubStream != load.stream.sessionId {
      let here = load.item?["source"].map { (source: $0, position: player.position) }
      await recover(welcome, deviceId: deviceId, here: here, leaveOnFailure: true)
      return
    }
    // The stream on screen is Yolo's: the pause or resume, then the seek,
    // then one report of where that left it.
    if missed.pause { player.pause(report: false) } else if missed.resume { player.resume() }
    if let position = missed.seek { seek(to: position) }
    player.reportNow()
    if let finished = player.finished, finished.sendsAgain(after: welcome, missed: missed) { player.sendEndedAgain() }
  }

  /// A seek the stream on screen cannot reach (before a resumed
  /// transcode's first segment): ask for a stream of its own there.
  private func requestStream(at position: Double) async {
    guard let paired, let load = player.current, let source = load.item?["source"] else { return }
    let body: JSONValue = [
      "source": source, "startTime": .number(position), "reason": "seek", "autoplay": .bool(player.isPlaying),
      "sessionId": .string(load.stream.sessionId), "deviceId": paired.credential.deviceId.map { .string($0) } ?? .null,
      "network": mediaPath?.path.map { .string($0.rawValue) } ?? .null,
    ]
    try? await APIClient(address: paired.address, credential: paired.credential).play(body)
  }

  // MARK: Playing from the home screen

  /// Plays an item here: the `load` arrives on the realtime channel.
  func play(_ item: MediaItem) {
    play(item.playReference, title: item.episodeTitle ?? item.title)
  }

  /// Plays a video link here.
  func play(url: String) {
    play(["url": .string(url)], title: url)
  }

  private func play(_ reference: [String: JSONValue], title: String) {
    guard let paired, starting == nil else { return }
    starting = title
    let connection = realtime
    Task {
      do {
        let deviceId = await connection?.deviceId ?? paired.credential.deviceId
        try await APIClient(address: paired.address, credential: paired.credential).playHere(reference, deviceId: deviceId, network: mediaPath?.path)
      } catch let error as YoloAPIError {
        playError = error.message
        starting = nil
      } catch {
        playError = error.localizedDescription
        starting = nil
      }
    }
  }

  /// The owner pressed Back on the player.
  func leftPlayer() {
    guard let left = player.stop(reportIdle: true) else { return }
    leftStream = left
    ownActions?.note(.playback)
  }

  /// A welcome that names this device still playing a stream it does not
  /// have (the app was closed or the connection lost it): ask for it again.
  private func recover(
    _ welcome: Welcome, deviceId: String?, here: (source: JSONValue, position: Double)? = nil, leaveOnFailure: Bool = false
  ) async {
    guard let paired,
          let request = RecoveryRequest(welcomeState: welcome.state, deviceId: deviceId, playing: player.sessionId, network: mediaPath?.path, here: here)
    else { return }
    do {
      try await APIClient(address: paired.address, credential: paired.credential).play(request.body)
    } catch let error as YoloAPIError where error.code == "superseded" {
      // The stream on screen is newer than the welcome, or the Hub moved
      // on and its `load` follows: play on.
    } catch {
      if leaveOnFailure { player.stop(reportIdle: false) }
    }
  }

  /// Probes the media paths and tells the Hub (`network`) when the path
  /// changed, and once after each welcome.
  private func chooseMediaPath(_ media: MediaInfo, on connection: RealtimeConnection, announce: Bool) async {
    guard let paired else { return }
    let choice = await MediaPathProber(server: paired.address).choose(media)
    let changed = choice.path != mediaPath?.path
    mediaPath = choice
    if changed || announce {
      await connection.send("network", choice.networkFields(reason: "probe"))
    }
  }

  /// The owner chose to forget this server here.
  func forgetServer() async {
    if let paired {
      try? await APIClient(address: paired.address, credential: paired.credential).forgetSelf()
    }
    unpair()
  }

  private func unpair() {
    player.stop(reportIdle: false)
    leftStream = nil
    settled = SettledCommands()
    ownActions = nil
    let connection = realtime
    realtime = nil
    listening?.cancel()
    listening = nil
    Task { await connection?.stop() }
    store.clear()
    paired = nil
    browser = nil
    artwork = nil
    starting = nil
    mediaPath = nil
    playback = nil
    realtimeStatus = .offline
    findServer()
  }
}

/// Where the left stream survives a relaunch: UserDefaults, as the player
/// keeps it in the tab's sessionStorage.
enum LeftStreamDefaults {
  private static let key = "yolo.leftStream"

  static func load() -> LeftStream? {
    UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(LeftStream.self, from: $0) }
  }

  static func save(_ left: LeftStream?) {
    if let left, let data = try? JSONEncoder().encode(left) {
      UserDefaults.standard.set(data, forKey: key)
    } else {
      UserDefaults.standard.removeObject(forKey: key)
    }
  }
}
