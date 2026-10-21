import AVFoundation
import AVKit
import Observation
import SwiftUI
import YoloKit

/// The screen's playback: AVPlayer plays a `load`'s stream, and what it does
/// goes back to the Hub as `report`, `ended`, and `error`
/// (Agent Note 2026-10-07-hub-and-realtime-channel). The system's player
/// view gives the transport bar, Siri Remote scrubbing, and Now Playing.
/// What the owner does with the remote (a pause, a scrub) is told to
/// AppModel as an own action, which stays unheard until Yolo answers a ping
/// after it (OwnActions).
@MainActor @Observable
final class TVPlayer {
  /// Sends one realtime message; set by AppModel.
  @ObservationIgnored var send: (String, [String: JSONValue]) -> Void = { _, _ in }
  /// The owner paused or sought with the remote.
  @ObservationIgnored var onOwnAction: (OwnAction) -> Void = { _ in }
  /// The stream failed where it plays: the app moves it to the next path,
  /// or tells Yolo `error` when none is left.
  @ObservationIgnored var onFailed: (_ load: Load, _ position: Double, _ message: String) -> Void = { _, _, _ in }
  /// A quality measurement, about every second while the stream plays or
  /// waits for data (QualityController).
  @ObservationIgnored var onSample: (QualityController.Sample) -> Void = { _ in }
  /// The item's timed comments, drawn over the picture.
  @ObservationIgnored var danmaku: Danmaku?
  /// Pings over the welcomed connection and calls back on its pong.
  @ObservationIgnored var confirm: (@escaping @Sendable () -> Void) async -> Bool = { _ in false }

  @ObservationIgnored let player = AVPlayer()
  private(set) var current: Load?
  private(set) var isPresented = false
  private(set) var status: PlaybackStatus = .idle
  /// The subtitle text showing now, drawn over the picture.
  private(set) var caption: String?
  /// The stream's tracks and the subtitles on screen.
  private(set) var tracks = StreamTracks.none
  @ObservationIgnored private var cues: [String: [Cue]] = [:]
  /// One reader per subtitle on screen: once, or again and again for a
  /// growing track.
  @ObservationIgnored private var readers: [String: Task<Void, Never>] = [:]
  /// Where the stream's relative URLs resolve: its media origin, else the server's.
  @ObservationIgnored private var base: URL?
  @ObservationIgnored private var captionObserver: Any?
  /// Reports and the stall watchdog run on their own clock: AVPlayer's time
  /// observer stands still while playback waits for data.
  @ObservationIgnored private var ticker: Task<Void, Never>?
  @ObservationIgnored private var stalledSince: ContinuousClock.Instant?
  /// Bytes the access log had counted at the last sample, and how many
  /// samples in a row measured a throughput.
  @ObservationIgnored private var lastBytes: Int64 = 0
  @ObservationIgnored private var samples = 0
  /// Waiting this long without the position moving gives the stream up on
  /// its path, as the player's `<video>` engine does (STALLED_AFTER_MS).
  static let stalledAfter: Duration = .seconds(30)

  @ObservationIgnored private var pacer = ReportPacer()
  @ObservationIgnored private var ready = false
  @ObservationIgnored private var timeline = StreamTimeline()
  @ObservationIgnored private var observations: [NSKeyValueObservation] = []
  @ObservationIgnored private var timeObserver: Any?
  @ObservationIgnored private var endObserver: NSObjectProtocol?
  @ObservationIgnored private var jumpObserver: NSObjectProtocol?
  @ObservationIgnored private var failObserver: NSObjectProtocol?
  /// The stream played to its end here, until anything plays, pauses, or
  /// seeks it or another stream starts.
  @ObservationIgnored private(set) var finished: FinishedStream?
  /// What Yolo or this app asked for, so the observers do not take it for
  /// the owner's: a pause, and seeks in flight.
  @ObservationIgnored private var commandedPause = false
  @ObservationIgnored private var seeksInFlight = 0
  /// AVPlayer may announce one of this app's seeks after it completed.
  @ObservationIgnored private var ownSeekSettlesAt = ContinuousClock.now
  @ObservationIgnored private var wasPlaying = false
  @ObservationIgnored private var reportedFailure = false
  @ObservationIgnored private var stalls = StallCounter()
  @ObservationIgnored private var healthPacer = HealthPacer()

  var sessionId: String? { current?.stream.sessionId }

  init() {
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    observations.append(player.observe(\.timeControlStatus) { [weak self] _, _ in
      Task { @MainActor in self?.timeControlChanged() }
    })
    timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1, preferredTimescale: 600), queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.update(force: false) }
    }
    captionObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.updateCaption() }
    }
    ticker = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        self?.tick()
      }
    }
  }

  /// Plays a `load`'s stream at its start, playing or paused as it says.
  func start(_ load: Load, url: URL, base: URL?, server: ServerAddress) {
    releaseItem()
    current = load
    lastBytes = 0
    samples = 0
    danmaku?.load(load.stream, item: load.item, server: server, startTime: load.startTime)
    self.base = base
    readers.values.forEach { $0.cancel() }
    readers = [:]
    tracks = StreamTracks(json: load.stream.tracks)
    cues = [:]
    caption = nil
    loadSubtitles()
    ready = false
    timeline = StreamTimeline()
    finished = nil
    commandedPause = false
    seeksInFlight = 0
    wasPlaying = false
    reportedFailure = false
    stalledSince = nil
    stalls = StallCounter()
    let item = AVPlayerItem(url: url)
    if let title = load.stream.title ?? load.item?["title"]?.string {
      let metadata = AVMutableMetadataItem()
      metadata.identifier = .commonIdentifierTitle
      metadata.value = title as NSString
      item.externalMetadata = [metadata]
    }
    observations.append(item.observe(\.status) { [weak self] item, _ in
      let status = item.status
      Task { @MainActor in self?.itemStatusChanged(status, of: item) }
    })
    endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.ended() }
    }
    jumpObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.timeJumpedNotification, object: item, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.timeJumped() }
    }
    failObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main) { [weak self] note in
      let error = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
      let message = error?.localizedDescription ?? "The stream stopped before its end"
      MainActor.assumeIsolated { self?.failed(message) }
    }
    player.replaceCurrentItem(with: item)
    isPresented = true
    update(force: true)
  }

  private func itemStatusChanged(_ status: AVPlayerItem.Status, of item: AVPlayerItem) {
    guard item === player.currentItem, let load = current else { return }
    switch status {
    case .readyToPlay where !ready:
      ready = true
      let streamDuration = item.duration.seconds
      timeline = StreamTimeline(
        trimToStart: load.stream.trimToStart, itemDuration: load.stream.duration,
        streamDuration: streamDuration.isFinite ? streamDuration : nil, startTime: load.startTime, isLive: load.stream.isLive
      )
      let start = timeline.streamTime(load.startTime) ?? 0
      if start > 0.5 {
        seeksInFlight += 1
        player.seek(to: CMTime(seconds: start, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
          Task { @MainActor in
            self?.seekCompleted()
            self?.begin(load)
          }
        }
      } else {
        begin(load)
      }
    case .failed:
      failed(item.error?.localizedDescription ?? "AVPlayer could not play this stream")
    default:
      break
    }
  }

  /// Every second: the report when it is due, and the stall watchdog.
  private func tick() {
    guard current != nil else { return }
    update(force: false)
    if ready, seeksInFlight == 0, status == .playing || status == .buffering { onSample(qualitySample()) }
    if ready && status == .buffering {
      let now = ContinuousClock.now
      let since = stalledSince ?? now
      stalledSince = since
      if now - since >= Self.stalledAfter {
        stalledSince = nil
        failed("The stream stalled for \(Int(Self.stalledAfter.components.seconds)) seconds without new data")
      }
    } else {
      stalledSince = nil
    }
  }

  /// What adaptive quality reads: AVPlayer's measured throughput, the
  /// buffer ahead, and whether it waits for data.
  private func qualitySample() -> QualityController.Sample {
    let item = player.currentItem
    let event = item?.accessLog()?.events.last
    let bytes = event?.numberOfBytesTransferred ?? 0
    let downloading = bytes > lastBytes
    lastBytes = bytes
    let throughput = max(0, (event?.observedBitrate ?? 0) / 1000)
    samples = throughput > 0 ? samples + 1 : 0
    let time = player.currentTime().seconds
    let end = item?.loadedTimeRanges.map(\.timeRangeValue).first { $0.start.seconds <= time + 0.5 && $0.end.seconds >= time }?.end.seconds
    let streamDuration = item?.duration.seconds
    let restBuffered = end.flatMap { end in streamDuration.map { $0.isFinite && end >= $0 - 0.5 } } ?? false
    return QualityController.Sample(
      throughputKbps: throughput, sampleCount: samples, bufferedAhead: end.map { max(0, $0 - time) } ?? 0,
      buffering: status == .buffering, downloading: downloading,
      remaining: duration.map { max(0, $0 - position) }, restBuffered: restBuffered, rate: Double(max(1, player.rate))
    )
  }

  /// The stream failed: once per stream, where it was.
  private func failed(_ message: String) {
    guard let load = current, !reportedFailure else { return }
    reportedFailure = true
    onFailed(load, ready ? position : load.startTime, message)
  }

  /// Tells Yolo the stream failed and nothing can play it here.
  func reportError(_ load: Load, message: String) {
    send("error", ["sessionId": .string(load.stream.sessionId), "code": "PLAYBACK_FAILED", "message": .string(message)])
  }

  /// The stream stands at its start: play, or say it waits paused.
  private func begin(_ load: Load) {
    guard current == load else { return }
    if load.autoplay { player.play() } else { update(force: true) }
  }

  // MARK: Subtitles

  /// The ids of the subtitles on screen.
  var subtitles: [String] { current == nil ? [] : tracks.selected.filter { tracks.subtitle($0)?.inPlace == true } }

  /// A `tracks` message: new tracks, the selection, or both.
  func applyTracks(_ next: JSONValue?, selected: JSONValue?) {
    guard current != nil else { return }
    tracks = tracks.applying(tracks: next, selected: selected)
    loadSubtitles()
  }

  /// Shows the subtitles a welcome says Yolo chose.
  func showSubtitles(_ ids: [String]) {
    tracks.selected = ids
    loadSubtitles()
  }

  private func loadSubtitles() {
    let wanted = Set(subtitles)
    for (id, reader) in readers where !wanted.contains(id) {
      reader.cancel()
      readers[id] = nil
    }
    cues = cues.filter { wanted.contains($0.key) }
    updateCaption()
    for id in wanted where readers[id] == nil {
      guard let track = tracks.subtitle(id), let path = track.url, let url = URL(string: path, relativeTo: base)?.absoluteURL else { continue }
      let sessionId = current?.stream.sessionId
      readers[id] = Task { [weak self] in await self?.read(id, url: url, growing: track.growing, sessionId: sessionId) }
    }
  }

  /// Reads one subtitle track. A track still being prepared (425) or limited
  /// by its site (429) is asked once more after its Retry-After, at most two
  /// minutes, as the player's `subtitle-loading.js` does; a growing track is
  /// read again every few seconds for a window around the position, and at
  /// once after a jump (GrowingSubtitles).
  private func read(_ id: String, url: URL, growing: Bool, sessionId: String?) async {
    var retried = false
    while !Task.isCancelled, current?.stream.sessionId == sessionId {
      let window = growing ? GrowingSubtitles.window(at: position) : nil
      var request = URLRequest(url: window.map { GrowingSubtitles.url(url, window: $0) } ?? url)
      request.cachePolicy = .reloadIgnoringLocalCacheData
      let answer = try? await URLSession.shared.data(for: request)
      guard !Task.isCancelled, current?.stream.sessionId == sessionId else { return }
      let status = (answer?.1 as? HTTPURLResponse)?.statusCode
      if status == 200, let data = answer?.0 {
        let fresh = WebVTT.parse(String(decoding: data, as: UTF8.self))
        cues[id] = window.map { GrowingSubtitles.merge(cues[id] ?? [], fresh: fresh, window: $0) } ?? fresh
        updateCaption()
        if !growing { return }
      } else if !growing {
        guard status == 425 || status == 429, !retried else { return }
        retried = true
        let wait = Double((answer?.1 as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 10
        try? await Task.sleep(for: .seconds(min(120, max(1, wait))))
        continue
      }
      let askedAt = position
      let until = ContinuousClock.now + GrowingSubtitles.poll
      while ContinuousClock.now < until, abs(position - askedAt) <= GrowingSubtitles.jump {
        try? await Task.sleep(for: .milliseconds(500))
        if Task.isCancelled { return }
      }
    }
  }

  private func updateCaption() {
    let time = position
    let text = subtitles.compactMap { cues[$0].flatMap { WebVTT.text(at: time, in: $0) } }.joined(separator: "\n")
    let next = text.isEmpty ? nil : text
    if next != caption { caption = next }
  }

  // MARK: Commands

  /// Yolo's pause. `report: false` when a welcome reports once, after
  /// everything it changed.
  func pause(report: Bool = true) {
    finished = nil
    if player.timeControlStatus != .paused { commandedPause = true }
    player.pause()
    if report { update(force: true) }
  }

  func resume() {
    finished = nil
    player.play()
    update(force: true)
  }

  /// One report now, whatever the pacing.
  func reportNow() {
    update(force: true)
  }

  var isPlaying: Bool { player.timeControlStatus != .paused }

  /// Seeks to an item position. False when the position lies before the
  /// stream's first segment, which takes a new stream.
  func seek(to position: Double) -> Bool {
    guard let target = timeline.streamTime(position) else { return false }
    finished = nil
    seeksInFlight += 1
    player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
      Task { @MainActor in
        self?.seekCompleted()
        self?.update(force: true)
      }
    }
    return true
  }

  /// Ends playback here. `reportIdle` when the owner left it (Back), so the
  /// Hub keeps the position and stops the node's session; not when the Hub
  /// stopped it or moved it to another screen. Returns the stream left.
  @discardableResult
  func stop(reportIdle: Bool) -> LeftStream? {
    guard let load = current else { return nil }
    let left = LeftStream(sessionId: load.stream.sessionId, position: position)
    if reportIdle {
      send("report", PlaybackReport(sessionId: left.sessionId, status: .idle, position: left.position, duration: duration, playing: false).fields)
    }
    commandedPause = true
    player.pause()
    releaseItem()
    current = nil
    finished = nil
    danmaku?.clear()
    readers.values.forEach { $0.cancel() }
    readers = [:]
    tracks = .none
    cues = [:]
    caption = nil
    status = .idle
    isPresented = false
    return reportIdle ? left : nil
  }

  /// Played to its end: Yolo takes the queue's next item. The `ended`
  /// counts as heard once Yolo answers a ping sent after it.
  private func ended() {
    guard let load = current else { return }
    update(force: true)
    let sessionId = load.stream.sessionId
    finished = FinishedStream(sessionId: sessionId)
    send("ended", ["sessionId": .string(sessionId)])
    let confirm = confirm
    Task { [weak self] in
      _ = await confirm { [weak self] in
        Task { @MainActor in
          if self?.finished?.sessionId == sessionId { self?.finished?.heard = true }
        }
      }
    }
  }

  /// Says `ended` again for a stream a welcome shows Yolo never heard end.
  func sendEndedAgain() {
    guard let finished else { return }
    send("ended", ["sessionId": .string(finished.sessionId)])
  }

  // MARK: What the owner does

  private func timeControlChanged() {
    let now = ContinuousClock.now
    switch player.timeControlStatus {
    case .playing:
      stalls.resumed(at: now)
      wasPlaying = true
      finished = nil
    case .waitingToPlayAtSpecifiedRate:
      if ready && wasPlaying && seeksInFlight == 0 { stalls.stalled(at: now) }
    case .paused:
      stalls.resumed(at: now)
      let atEnd = (duration ?? .infinity) - position < 1
      if ready && wasPlaying && !commandedPause && finished == nil && !atEnd { onOwnAction(.playback) }
      commandedPause = false
      wasPlaying = false
    @unknown default:
      break
    }
    update(force: false)
  }

  private func seekCompleted() {
    seeksInFlight -= 1
    ownSeekSettlesAt = .now + .seconds(1)
  }

  private func timeJumped() {
    guard ready, seeksInFlight == 0, ContinuousClock.now > ownSeekSettlesAt, current != nil else { return }
    finished = nil
    onOwnAction(.seek)
    update(force: true)
  }

  // MARK: Reports

  var position: Double {
    let seconds = player.currentTime().seconds
    return timeline.itemTime(seconds.isFinite ? max(0, seconds) : 0)
  }

  private var duration: Double? {
    guard let load = current, !load.stream.isLive else { return nil }
    if let item = load.stream.duration, item > 0 { return item }
    guard let seconds = player.currentItem?.duration.seconds, seconds.isFinite, seconds > 0 else { return nil }
    return timeline.itemTime(seconds)
  }

  private func currentStatus() -> PlaybackStatus {
    guard current != nil else { return .idle }
    if !ready { return .loading }
    switch player.timeControlStatus {
    case .playing: return .playing
    case .waitingToPlayAtSpecifiedRate: return .buffering
    default: return .paused
    }
  }

  private func update(force: Bool) {
    guard let load = current else { return }
    status = currentStatus()
    var report = PlaybackReport(
      sessionId: load.stream.sessionId, status: status, position: position, duration: duration,
      playing: player.timeControlStatus == .playing, viewport: ThisDevice.viewport
    )
    let now = ContinuousClock.now
    guard pacer.due(report, at: now, force: force) else { return }
    if ready, healthPacer.take(sessionId: load.stream.sessionId, stalls: stalls.count, buffering: status == .buffering, at: now) {
      report.health = health(at: now)
    }
    pacer.sent(report, at: now)
    send("report", report.fields)
  }

  /// AVPlayer's own measurements: what it buffered ahead of the position,
  /// the throughput its access log observed, the picture, and dropped frames.
  private func health(at now: ContinuousClock.Instant) -> PlaybackHealth {
    var health = PlaybackHealth()
    let item = player.currentItem
    let time = player.currentTime().seconds
    if let item, time.isFinite {
      let ahead = item.loadedTimeRanges.map(\.timeRangeValue)
        .first { $0.start.seconds <= time + 0.5 && $0.end.seconds >= time }
        .map { $0.end.seconds - time }
      health.bufferSeconds = ahead ?? 0
    }
    let events = item?.accessLog()?.events ?? []
    if let observed = events.last?.observedBitrate, observed > 0 { health.throughputKbps = observed / 1000 }
    let dropped = events.reduce(0) { $0 + max(0, $1.numberOfDroppedVideoFrames) }
    health.droppedFrames = events.isEmpty ? nil : dropped
    if let size = item?.presentationSize, size.width > 0 {
      health.width = Int(size.width)
      health.height = Int(size.height)
    }
    health.buffering = status == .buffering
    health.stalls = stalls.count
    health.stallSeconds = stalls.seconds(at: now)
    health.recentStalls = stalls.recent(at: now)
    return health
  }

  private func releaseItem() {
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    if let jumpObserver { NotificationCenter.default.removeObserver(jumpObserver) }
    if let failObserver { NotificationCenter.default.removeObserver(failObserver) }
    endObserver = nil
    jumpObserver = nil
    failObserver = nil
    // The first observation watches the player; the rest watched items.
    observations.dropFirst().forEach { $0.invalidate() }
    observations = Array(observations.prefix(1))
    player.replaceCurrentItem(with: nil)
  }
}

/// The system's player view, full screen: the transport bar, scrubbing with
/// the Siri Remote, and Back. Text subtitles are drawn over the picture in
/// its content overlay, since AVPlayer cannot attach a sidecar WebVTT file to
/// a stream (Agent Note 2026-10-19-apple-tv-client).
struct PlayerScreen: UIViewControllerRepresentable {
  let player: AVPlayer
  let caption: String?
  /// The stream's subtitles for the transport bar's menu, the ones on screen
  /// checked.
  var tracks: StreamTracks = .none
  var chooseSubtitles: ([String]) -> Void = { _ in }
  var chooseAudio: (String) -> Void = { _ in }
  var share: () -> Void = {}
  /// Danmaku: drawn over the picture, under the subtitles.
  var danmaku: Danmaku?
  var danmakuSettings = DanmakuSettings()
  var danmakuAvailable = false
  var changeDanmaku: ([String: JSONValue]) -> Void = { _ in }
  var time: () -> Double = { 0 }

  func makeUIViewController(context: Context) -> AVPlayerViewController {
    let controller = AVPlayerViewController()
    controller.player = player
    // The system's speed menu, 0.5x to 2x; the speed lasts while the app
    // runs, as the player's lasts for the page.
    controller.speeds = AVPlaybackSpeed.systemDefaultSpeeds
    let label = UILabel()
    label.numberOfLines = 0
    label.textAlignment = .center
    label.textColor = .white
    label.font = .systemFont(ofSize: 48, weight: .semibold)
    label.layer.shadowColor = UIColor.black.cgColor
    label.layer.shadowRadius = 4
    label.layer.shadowOpacity = 0.9
    label.layer.shadowOffset = .zero
    label.translatesAutoresizingMaskIntoConstraints = false
    if let overlay = controller.contentOverlayView {
      let comments = DanmakuView(frame: overlay.bounds)
      comments.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      comments.danmaku = danmaku
      comments.time = time
      comments.subtitles = { [weak label] in label?.text?.isEmpty == false }
      // The picture, aspect-fit in the screen: tvOS has no videoBounds.
      comments.picture = { [weak player, weak comments] in
        guard let comments else { return .zero }
        let size = player?.currentItem?.presentationSize ?? .zero
        return size.width > 0 ? AVMakeRect(aspectRatio: size, insideRect: comments.bounds) : comments.bounds
      }
      overlay.addSubview(comments)
      overlay.addSubview(label)
      NSLayoutConstraint.activate([
        label.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
        label.widthAnchor.constraint(lessThanOrEqualTo: overlay.widthAnchor, multiplier: 0.8),
        label.bottomAnchor.constraint(equalTo: overlay.bottomAnchor, constant: -96),
      ])
    }
    context.coordinator.label = label
    return controller
  }

  func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
    context.coordinator.label?.text = caption
    let selected = Set(tracks.selected)
    let off = UIAction(title: "Off", state: selected.isEmpty ? .on : .off) { _ in chooseSubtitles([]) }
    let choices = tracks.subtitles.map { track in
      UIAction(title: track.name ?? track.language ?? track.id, state: selected.contains(track.id) ? .on : .off) { _ in
        chooseSubtitles([track.id])
      }
    }
    var items: [UIMenuElement] = []
    if !tracks.subtitles.isEmpty {
      items.append(UIMenu(title: "Subtitles", image: UIImage(systemName: "captions.bubble"), options: .singleSelection, children: [off] + choices))
    }
    // Audio: only with more than one track; a change is a new stream.
    if tracks.audio.count > 1 {
      let current = tracks.currentAudio
      let audio = tracks.audio.map { track in
        UIAction(title: track.label, state: track.id == current ? .on : .off) { _ in chooseAudio(track.id) }
      }
      items.append(UIMenu(title: "Audio", image: UIImage(systemName: "speaker.wave.2"), options: .singleSelection, children: audio))
    }
    if danmakuAvailable { items.append(danmakuMenu()) }
    items.append(UIAction(title: "Share", image: UIImage(systemName: "qrcode")) { _ in share() })
    controller.transportBarCustomMenuItems = items
  }

  /// The player's danmaku settings, as Settings > This screen offers them.
  private func danmakuMenu() -> UIMenu {
    let settings = danmakuSettings
    func choices(_ title: String, _ key: String, _ options: [(String, JSONValue)], current: JSONValue) -> UIMenu {
      UIMenu(title: title, options: .singleSelection, children: options.map { label, value in
        UIAction(title: label, state: value == current ? .on : .off) { _ in changeDanmaku([key: value]) }
      })
    }
    let toggle = UIAction(title: settings.enabled ? "Hide danmaku" : "Show danmaku") { _ in changeDanmaku(["enabled": .bool(!settings.enabled)]) }
    return UIMenu(title: "Danmaku", image: UIImage(systemName: settings.enabled ? "text.bubble.fill" : "text.bubble"), children: [
      toggle,
      choices("Density", "density", [("Fewer", "low"), ("Normal", "normal"), ("All", "high")], current: .string(settings.density)),
      choices("Area", "area", [("Full", "full"), ("Top half", "half"), ("Top quarter", "quarter")], current: .string(settings.area)),
      choices("Opacity", "opacity", DanmakuSettings.opacities.map { ("\(Int($0 * 100))%", .number($0)) },
              current: .number(DanmakuSettings.opacities.min { abs($0 - settings.opacity) < abs($1 - settings.opacity) } ?? 0.8)),
      choices("Text size", "fontSize", [("Small", "small"), ("Normal", "normal"), ("Large", "large")], current: .string(settings.fontSize)),
    ])
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  final class Coordinator {
    var label: UILabel?
  }
}
