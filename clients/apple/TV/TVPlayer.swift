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
  /// Pings over the welcomed connection and calls back on its pong.
  @ObservationIgnored var confirm: (@escaping @Sendable () -> Void) async -> Bool = { _ in false }

  @ObservationIgnored let player = AVPlayer()
  private(set) var current: Load?
  private(set) var isPresented = false
  private(set) var status: PlaybackStatus = .idle

  @ObservationIgnored private var pacer = ReportPacer()
  @ObservationIgnored private var ready = false
  @ObservationIgnored private var timeline = StreamTimeline()
  @ObservationIgnored private var observations: [NSKeyValueObservation] = []
  @ObservationIgnored private var timeObserver: Any?
  @ObservationIgnored private var endObserver: NSObjectProtocol?
  @ObservationIgnored private var jumpObserver: NSObjectProtocol?
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
  }

  /// Plays a `load`'s stream at its start, playing or paused as it says.
  func start(_ load: Load, url: URL) {
    releaseItem()
    current = load
    ready = false
    timeline = StreamTimeline()
    finished = nil
    commandedPause = false
    seeksInFlight = 0
    wasPlaying = false
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
      let message = item.error?.localizedDescription ?? "AVPlayer could not play this stream"
      send("error", ["sessionId": .string(load.stream.sessionId), "code": "PLAYBACK_FAILED", "message": .string(message)])
    default:
      break
    }
  }

  /// The stream stands at its start: play, or say it waits paused.
  private func begin(_ load: Load) {
    guard current == load else { return }
    if load.autoplay { player.play() } else { update(force: true) }
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
    endObserver = nil
    jumpObserver = nil
    // The first observation watches the player; the rest watched items.
    observations.dropFirst().forEach { $0.invalidate() }
    observations = Array(observations.prefix(1))
    player.replaceCurrentItem(with: nil)
  }
}

/// The system's player view, full screen: the transport bar, scrubbing with
/// the Siri Remote, and Back.
struct PlayerScreen: UIViewControllerRepresentable {
  let player: AVPlayer

  func makeUIViewController(context: Context) -> AVPlayerViewController {
    let controller = AVPlayerViewController()
    controller.player = player
    return controller
  }

  func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {}
}
