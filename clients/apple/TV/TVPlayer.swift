import AVFoundation
import AVKit
import Observation
import SwiftUI
import YoloKit

/// The screen's playback: AVPlayer plays a `load`'s stream, and what it does
/// goes back to the Hub as `report`, `ended`, and `error`
/// (Agent Note 2026-10-07-hub-and-realtime-channel). The system's player
/// view gives the transport bar, Siri Remote scrubbing, and Now Playing.
@MainActor @Observable
final class TVPlayer {
  /// Sends one realtime message; set by AppModel.
  @ObservationIgnored var send: (String, [String: JSONValue]) -> Void = { _, _ in }

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

  var sessionId: String? { current?.stream.sessionId }

  init() {
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    observations.append(player.observe(\.timeControlStatus) { [weak self] _, _ in
      Task { @MainActor in self?.update(force: false) }
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
        player.seek(to: CMTime(seconds: start, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
          Task { @MainActor in self?.begin(load) }
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

  func pause() {
    player.pause()
    update(force: true)
  }

  func resume() {
    player.play()
    update(force: true)
  }

  var isPlaying: Bool { player.timeControlStatus != .paused }

  /// Seeks to an item position. False when the position lies before the
  /// stream's first segment, which takes a new stream.
  func seek(to position: Double) -> Bool {
    guard let target = timeline.streamTime(position) else { return false }
    player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
      Task { @MainActor in self?.update(force: true) }
    }
    return true
  }

  /// Ends playback here. `reportIdle` when the owner left it (Back), so the
  /// Hub keeps the position and stops the node's session; not when the Hub
  /// stopped it or moved it to another screen.
  func stop(reportIdle: Bool) {
    guard let load = current else { return }
    if reportIdle {
      send("report", PlaybackReport(sessionId: load.stream.sessionId, status: .idle, position: position, duration: duration, playing: false).fields)
    }
    player.pause()
    releaseItem()
    current = nil
    status = .idle
    isPresented = false
  }

  private func ended() {
    guard let load = current else { return }
    update(force: true)
    send("ended", ["sessionId": .string(load.stream.sessionId)])
  }

  // MARK: Reports

  private var position: Double {
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
    let report = PlaybackReport(
      sessionId: load.stream.sessionId, status: status, position: position, duration: duration,
      playing: player.timeControlStatus == .playing, viewport: ThisDevice.viewport
    )
    let now = ContinuousClock.now
    guard pacer.due(report, at: now, force: force) else { return }
    pacer.sent(report, at: now)
    send("report", report.fields)
  }

  private func releaseItem() {
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    endObserver = nil
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
