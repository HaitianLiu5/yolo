import Foundation
import Observation
import YoloKit

/// What the app shows and the work behind each screen: finding the owner's
/// server, pairing, and staying on the realtime channel once paired.
@MainActor @Observable
final class AppModel {
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

  private let store: any PairingStore
  private var browsing: Task<Void, Never>?
  private var pairing: Task<Void, Never>?
  private var listening: Task<Void, Never>?
  private var realtime: RealtimeConnection?

  init(store: any PairingStore = KeychainPairingStore()) {
    self.store = store
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
    screen = .ready
    let connection = RealtimeConnection(
      api: APIClient(address: paired.address, credential: paired.credential),
      hello: { await ThisDevice.hello() }
    )
    realtime = connection
    player.send = { type, fields in
      Task { await connection.send(type, fields) }
    }
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
    case .message(let message, _):
      if let welcome = Welcome(message) {
        playback = welcome.state?["status"]?.string
        if let media = welcome.media { await chooseMediaPath(media, on: connection, announce: true) }
        await recover(welcome, deviceId: await connection.deviceId)
      } else if let load = Load(message) {
        start(load)
      } else if let command = PlaybackCommand(message) {
        apply(command)
      } else if message.type == "state" {
        playback = message["state"]?["status"]?.string
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

  private func apply(_ command: PlaybackCommand) {
    guard command.applies(to: player.sessionId) else { return }
    switch command {
    case .pause: player.pause()
    case .resume: player.resume()
    case .seek(_, let position):
      if !player.seek(to: position) { Task { await requestStream(at: position) } }
    case .stop, .deactivate: player.stop(reportIdle: false)
    }
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

  /// The owner pressed Back on the player.
  func leftPlayer() {
    player.stop(reportIdle: true)
  }

  /// A welcome that names this device still playing a stream it does not
  /// have (the app was closed or the connection lost it): ask for it again.
  private func recover(_ welcome: Welcome, deviceId: String?) async {
    guard let paired,
          let request = RecoveryRequest(welcomeState: welcome.state, deviceId: deviceId, playing: player.sessionId, network: mediaPath?.path)
    else { return }
    do {
      try await APIClient(address: paired.address, credential: paired.credential).play(request.body)
    } catch {
      // Superseded: the Hub moved on, and its `load` follows.
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
    let connection = realtime
    realtime = nil
    listening?.cancel()
    listening = nil
    Task { await connection?.stop() }
    store.clear()
    paired = nil
    mediaPath = nil
    playback = nil
    realtimeStatus = .offline
    findServer()
  }
}
