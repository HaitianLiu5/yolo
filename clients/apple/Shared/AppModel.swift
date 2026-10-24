import Foundation
import Observation
import os
import YoloKit

/// What the app shows and the work behind each screen: finding the owner's
/// server, pairing, and staying on the realtime channel once paired.
@MainActor @Observable
final class AppModel {
  /// What the realtime channel made this screen do: `log stream --predicate
  /// 'subsystem == "dev.yolo.tv"'` (or `dev.yolo.ios`) on the Mac shows it.
  static let log = Logger(subsystem: ThisDevice.logSubsystem, category: "realtime")

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
  /// The paths the last welcome or `media` message listed.
  private var media: MediaInfo?
  /// Probes again while the LAN does not answer; its count picks the wait.
  private var reprobe: Task<Void, Never>?
  private var reprobes = 0
  /// One round at a time: a round asked for meanwhile runs after it, so the
  /// Hub hears each change of path once.
  private var probing = false
  private var probeAgain: (media: MediaInfo, announce: Bool)?
  private var probeRounds = 0
  /// The long LAN probe of a round before the LAN was ever reached. It runs
  /// apart, so a `media` message meanwhile is not held behind it, and a
  /// newer round discards what it finds.
  private var firstReach: Task<Void, Never>?
  /// Whether this install ever reached the LAN listener: until then the
  /// system's local network prompt may hold the first probe. Kept apart in
  /// a conformance run, which must not depend on the runs before it.
  private static let lanReachedKey = "yolo.lanReached"
  private var lanReached = false {
    didSet { if lanReached, !conformance { UserDefaults.standard.set(true, forKey: Self.lanReachedKey) } }
  }
  /// The Hub's playback status for the owner's screens, from the latest
  /// welcome or `state` broadcast.
  private(set) var playback: String?
  let player = Player()
  /// The home screen's rows, once paired.
  private(set) var browser: Browser?
  private(set) var artwork: ArtworkLoader?
  /// Requests to the owner's agent.
  private(set) var ask: AskModel?
  /// What a press asked to play, until its `load` arrives.
  private(set) var starting: String?
  /// A share link to show as a QR code over the player, for a minute.
  private(set) var shareLink: URL?
  private var shareHide: Task<Void, Never>?
  var playError: String?

  private let store: any PairingStore
  /// The last pause or resume and seek dealt with for the stream on screen.
  private var settled = SettledCommands()
  /// The screen's danmaku: settings, comments, and layout.
  let danmaku: Danmaku
  /// Per danmaku setting, the id of the last change from Yolo applied to it,
  /// and what the owner changed here unheard before the last welcome.
  private var danmakuHeard: [String: String] = [:]
  private var danmakuOwnAtWelcome: Set<String> = []
  /// Adaptive quality: the device's bitrate cap.
  private var quality = QualityController()
  @ObservationIgnored private let clockStart = ContinuousClock.now
  /// What the owner did here that Yolo may not have heard.
  private var ownActions: OwnActions?
  /// A stream the owner left with Back that Yolo may not have heard left,
  /// kept across launches.
  private var leftStream: LeftStream? {
    didSet { if !conformance { LeftStreamDefaults.save(leftStream) } }
  }
  /// What the Hub last sent this screen: `state`, `queue`, `playlists`, and
  /// `devices`, as the conformance kit's debug state shows them.
  private var shown: [String: JSONValue] = [:]
  private var deviceId: String?
  private let conformance: Bool
  #if DEBUG
  private var debugChannel: DebugChannel?
  #endif
  private var browsing: Task<Void, Never>?
  private var pairing: Task<Void, Never>?
  private var listening: Task<Void, Never>?
  private var realtime: RealtimeConnection?

  init(store: (any PairingStore)? = nil) {
    #if DEBUG
    conformance = Conformance.url != nil
    #else
    conformance = false
    #endif
    self.store = store ?? (conformance ? MemoryPairingStore() : KeychainPairingStore())
    danmaku = Danmaku(persist: !conformance)
    leftStream = conformance ? nil : LeftStreamDefaults.load()
    lanReached = !conformance && UserDefaults.standard.bool(forKey: Self.lanReachedKey)
  }

  /// SwiftUI may run the root view's task again; the app starts once.
  private var launched = false

  func launch() {
    guard !launched, screen == .starting else { return }
    launched = true
    #if DEBUG
    Self.log.info("launch: conformance \(Conformance.url ?? "off", privacy: .public); arguments \(ProcessInfo.processInfo.arguments.dropFirst().joined(separator: " "), privacy: .public)")
    #endif
    #if DEBUG
    if let kit = Conformance.url {
      debugChannel = DebugChannel(kit: kit) { [weak self] in self?.debugState ?? [:] }
      debugChannel?.start()
      connect(typed: kit)
      return
    }
    #endif
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
    let client = PairingClient(address: address, deviceName: ThisDevice.name, identity: ThisDevice.identity)
    pairing = Task {
      do {
        let credential = try await client.pair { event in await self.show(event) }
        let paired = PairedServer(address: address, credential: credential)
        do {
          try store.save(paired)
        } catch {
          pairingStatus = "Paired, but this \(ThisDevice.noun) could not keep the credential (\(error))."
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
      pairingStatus = ThisDevice.pairingPrompt
    case .unreachable(let message):
      pairingStatus = "Cannot reach Yolo (\(message)). Trying again…"
    case .refused(let message):
      pairingStatus = "\(message). Trying again…"
    case .denied:
      pairingStatus = "This \(ThisDevice.noun) was denied. A new code follows shortly."
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
    ask = AskModel(api: api)
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
    player.danmaku = danmaku
    player.onSample = { [weak self] sample in self?.sampled(sample) }
    player.onFailed = { [weak self] load, position, message in
      Task { await self?.streamFailed(load, at: position, message: message, on: connection) }
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
    case .message(let message, let welcomed):
      remember(message)
      if let welcome = Welcome(message) {
        deviceId = welcome.deviceId ?? deviceId
        await self.welcomed(welcome, on: connection)
      } else if let load = Load(message) {
        leftStream = nil
        starting = nil
        start(load)
      } else if let command = PlaybackCommand(message) {
        apply(command, id: message.id, welcomed: welcomed)
      } else if message.type == "danmaku" {
        let patch = DanmakuSettings.toApply(message, heard: danmakuHeard, own: danmakuOwnAtWelcome)
        if let id = message.id {
          for name in DanmakuSettings.patch(message["settings"]).keys { danmakuHeard[name] = id }
        }
        danmaku.update(patch)
      } else if message.type == "tracks" {
        player.applyTracks(message["tracks"], selected: message["selected"])
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
        "message": .string("\(ThisDevice.noun) cannot open a \(load.stream.deliveryType) stream"),
      ])
      return
    }
    let base = URL(string: (load.stream.origin ?? paired.address.origin) + "/")
    quality.load(
      limits: load.stream.limits, profile: load.stream.profile, isLive: load.stream.isLive,
      item: load.item?["source"]?.encodedString(), now: seconds
    )
    player.start(load, url: url, base: base, server: paired.address)
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

  /// The owner sought with the app's own controls; a position the stream
  /// cannot reach takes a new stream there.
  func seekHere(to position: Double) {
    guard player.current != nil else { return }
    if !player.ownerSeek(to: position) {
      ownActions?.note(.seek)
      Task { await requestStream(at: position) }
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
    danmakuOwnAtWelcome = Set(own.compactMap { if case .danmaku(let name) = $0 { name } else { nil } })
    if let ask { Task { await ask.refresh() } }
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
    // The stream on screen is Yolo's: the subtitles Yolo chose for it, the
    // pause or resume, then the seek, then one report of where that left it.
    if let ids = player.tracks.toFollow(state, deviceId: deviceId, sessionId: hubStream) { player.showSubtitles(ids) }
    if missed.pause { player.pause(report: false) } else if missed.resume { player.resume() }
    if let position = missed.seek { seek(to: position) }
    player.reportNow()
    if let finished = player.finished, finished.sendsAgain(after: welcome, missed: missed) { player.sendEndedAgain() }
  }

  /// A seek the stream on screen cannot reach (before a resumed
  /// transcode's first segment): ask for a stream of its own there.
  private func requestStream(at position: Double) async {
    _ = await rebuild(at: position, reason: "seek")
  }

  /// Asks for a new stream of what plays, in place of the one on screen,
  /// with the device's bitrate cap once a stream told it (as the player's
  /// `requestCap()`); `cap` overrides it for a quality change.
  private func rebuild(at position: Double, reason: String, cap: Int?? = nil, network: MediaPath?? = nil) async -> Bool {
    guard let paired, let load = player.current, let source = load.item?["source"] else { return false }
    var body: [String: JSONValue] = [
      "source": source, "startTime": .number(position), "reason": .string(reason), "autoplay": .bool(player.isPlaying || load.autoplay && reason == "recovery"),
      "sessionId": .string(load.stream.sessionId), "deviceId": (deviceId ?? paired.credential.deviceId).map { .string($0) } ?? .null,
      "network": (network ?? mediaPath?.path).map { .string($0.rawValue) } ?? .null,
    ]
    if let max = cap ?? quality.requestCap { body["maxVideoKbps"] = max.map { .number(Double($0)) } ?? .null }
    do {
      try await APIClient(address: paired.address, credential: paired.credential).play(.object(body))
      return true
    } catch {
      return false
    }
  }

  private var seconds: Double {
    let elapsed = ContinuousClock.now - clockStart
    return Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
  }

  /// A quality measurement: a step down or up is a new stream at the same
  /// position (`reason: "quality"`); the old one plays until it comes.
  private func sampled(_ sample: QualityController.Sample) {
    guard case .change(let cap) = quality.observe(sample, now: seconds) else { return }
    Task {
      if !(await rebuild(at: player.position, reason: "quality", cap: .some(cap))) { quality.abandon() }
    }
  }

  /// The owner chose an audio track: Yolo rebuilds the stream (`load`,
  /// reason `tracks`, the same session).
  func chooseAudio(_ id: String) {
    guard let paired else { return }
    Task {
      do {
        try await APIClient(address: paired.address, credential: paired.credential).setAudio(id)
      } catch let error as YoloAPIError {
        playError = error.message
      } catch {
        playError = error.localizedDescription
      }
    }
  }

  /// The owner changed a danmaku setting on this screen: unheard by Yolo
  /// until it answers a ping after it.
  func changeDanmaku(_ patch: [String: JSONValue]) {
    let valid = DanmakuSettings.patch(.object(patch))
    danmaku.update(valid)
    for name in valid.keys { ownActions?.note(.danmaku(name)) }
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

  /// The owner chose subtitles from the transport bar: Yolo answers with a
  /// `tracks` message, or a `load` for a track it burns in.
  func chooseSubtitles(_ ids: [String]) {
    guard let paired else { return }
    Task {
      do {
        try await APIClient(address: paired.address, credential: paired.credential).setTracks(subtitles: ids)
      } catch let error as YoloAPIError {
        playError = error.message
      } catch {
        playError = error.localizedDescription
      }
    }
  }

  /// A share link for what plays here, shown as a QR code a friend scans
  /// (Agent Note 2026-10-20-share-links).
  func share() {
    guard let paired, let source = player.current?.item?["source"] else { return }
    Task {
      do {
        let link = try await APIClient(address: paired.address, credential: paired.credential).share(["source": source])
        shareLink = link
        shareHide?.cancel()
        shareHide = Task {
          try? await Task.sleep(for: .seconds(60))
          if !Task.isCancelled { shareLink = nil }
        }
      } catch let error as YoloAPIError {
        playError = error.message
      } catch {
        playError = error.localizedDescription
      }
    }
  }

  /// The owner pressed Back on the player.
  func leftPlayer() {
    shareLink = nil
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
  /// changed, and once after each welcome. A LAN listener that does not
  /// answer is probed again later: tvOS and iOS hold connections to the
  /// home network until the owner allows local network access, and the first
  /// probe may come while its prompt shows (Agent Note
  /// 2026-10-12-lan-direct-play).
  private func chooseMediaPath(_ media: MediaInfo, on connection: RealtimeConnection, announce: Bool) async {
    guard paired != nil else { return }
    self.media = media
    if probing {
      probeAgain = (media, announce || (probeAgain?.announce ?? false))
      return
    }
    probing = true
    await probeRound(media, on: connection, announce: announce)
    while let next = probeAgain {
      probeAgain = nil
      await probeRound(next.media, on: connection, announce: next.announce)
    }
    probing = false
  }

  private func probeRound(_ media: MediaInfo, on connection: RealtimeConnection, announce: Bool) async {
    guard let paired else { return }
    probeRounds += 1
    let round = probeRounds
    firstReach?.cancel()
    let prober = MediaPathProber(server: paired.address)
    let choice = await prober.choose(media)
    let changed = choice.path != mediaPath?.path
    mediaPath = choice
    if changed || announce {
      await connection.send("network", choice.networkFields(reason: "probe"))
    }
    if choice.probes[.lan] == .ok { lanReached = true }
    guard media.lan != nil, choice.probes[.lan] != .ok, !lanReached else {
      scheduleReprobe(after: choice, media: media, on: connection)
      return
    }
    // Plays take the quick round's path meanwhile.
    firstReach = Task { [weak self] in
      let long = await prober.choose(media, lanTimeout: 60)
      guard let self, !Task.isCancelled, round == self.probeRounds else { return }
      if long.probes[.lan] == .ok { self.lanReached = true }
      if long.path != self.mediaPath?.path {
        self.mediaPath = long
        await connection.send("network", long.networkFields(reason: "probe"))
      }
      self.scheduleReprobe(after: long, media: media, on: connection)
    }
  }

  /// 30 seconds, a minute, two, then every five while the LAN does not
  /// answer; nothing once it does.
  private func scheduleReprobe(after choice: MediaPathChoice, media: MediaInfo, on connection: RealtimeConnection) {
    reprobe?.cancel()
    guard media.lan != nil, choice.probes[.lan] != .ok, choice.probes[.lan] != .off else {
      reprobes = 0
      return
    }
    let waits: [Duration] = [.seconds(30), .seconds(60), .seconds(120)]
    let wait = reprobes < waits.count ? waits[reprobes] : .seconds(300)
    reprobes += 1
    reprobe = Task {
      try? await Task.sleep(for: wait)
      guard !Task.isCancelled, let media = self.media else { return }
      await chooseMediaPath(media, on: connection, announce: false)
    }
  }

  /// The app came back to the foreground: the network may have changed.
  func becameActive() {
    guard let media, let connection = realtime else { return }
    reprobes = 0
    Task { await chooseMediaPath(media, on: connection, announce: false) }
  }

  private func remember(_ message: RealtimeMessage) {
    if message.type == "welcome" {
      for key in ["state", "queue", "playlists"] { if let value = message[key] { shown[key] = value } }
    } else if RealtimeMessage.broadcasts.contains(message.type), let value = message[message.type] {
      shown[message.type] = value
    }
  }

  /// What the conformance kit's debug socket asks for.
  var debugState: JSONValue {
    let screenName: String
    switch screen {
    case .ready: screenName = "ready"
    case .updateClient: screenName = "update-client"
    case .updateServer: screenName = "update-server"
    default: screenName = "pairing"
    }
    let devices = shown["devices"]?.array ?? []
    let mine = devices.first { $0["id"]?.string == deviceId }
    // A screen holding a stream the Hub sent it is the active one.
    let active = player.current != nil || (mine?["active"]?.bool ?? (deviceId != nil && shown["state"]?["deviceId"]?.string == deviceId))
    return [
      "screen": .string(screenName),
      "sessionId": player.sessionId.map { .string($0) } ?? .null,
      "paused": .bool(player.current != nil && !player.isPlaying),
      "position": player.current != nil ? .number((player.position * 1000).rounded() / 1000) : .null,
      "subtitles": .array(player.subtitles.map { .string($0) }),
      "active": .bool(active),
      "shown": .object(shown),
      // An extension the kit reads for the optional danmaku part.
      "danmaku": ["enabled": .bool(danmaku.settings.enabled), "available": .bool(danmaku.available), "onScreen": .number(Double(danmaku.onScreen))],
    ]
  }

  /// A stream that fails on its path moves the screen down the order at
  /// once, and the stream is rebuilt there at the same position (Agent Note
  /// 2026-10-13-media-off-the-worker); with no path left, Yolo hears
  /// `error`. A probe 30 seconds later may move it back up for the next
  /// stream.
  private func streamFailed(_ load: Load, at position: Double, message: String, on connection: RealtimeConnection) async {
    guard let paired, let media, let choice = mediaPath, let source = load.item?["source"] else {
      player.reportError(load, message: message)
      return
    }
    let on: MediaPath = load.stream.origin == media.lan?.origin ? .lan : load.stream.origin == media.wan?.origin ? .wan : .relay
    guard let next = choice.below(on, relay: media.relay) else {
      player.reportError(load, message: message)
      return
    }
    mediaPath = choice.movedDown(to: next)
    await connection.send("network", choice.movedDown(to: next).networkFields(reason: "media_error"))
    _ = paired
    _ = source
    if !(await rebuild(at: position, reason: "recovery", network: .some(next))) {
      player.reportError(load, message: message)
    }
    Task {
      try? await Task.sleep(for: .seconds(30))
      if let media = self.media { await chooseMediaPath(media, on: connection, announce: false) }
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
    reprobe?.cancel()
    reprobe = nil
    media = nil
    paired = nil
    ask?.stop()
    ask = nil
    deviceId = nil
    shown = [:]
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
