import Foundation

/// Which moments of a stream to read small pictures of while the owner
/// scrubs (Agent Note 2026-11-07-scrub-previews). Moments lie on a grid, at
/// most two reads run at once, and when one ends the next is the moment the
/// owner is at by then, so a fast scrub skips what it passed.
public struct PreviewSchedule: Sendable, Equatable {
  public static let maxReads = 2
  /// Failures in a row that end the reading until the next scrub.
  public static let maxFailures = 3

  public enum Outcome: Sendable, Equatable {
    case loaded
    /// The node had no room now: nothing is wrong with the moment.
    case busy
    case failed
  }

  /// Seconds between moments: every 2 seconds of a short video, at most 10.
  public let step: Int
  private let last: Int
  private var reading: Set<Int> = []
  private var loaded: Set<Int> = []
  private var failed: Set<Int> = []
  private var failures = 0
  private var wanted: Double?
  private var direction = 1

  public init(duration: Double) {
    let length = duration.isFinite ? max(0, duration) : 0
    step = max(2, min(10, Int((length / 300).rounded(.up))))
    last = max(0, (Int(length) - 1) / step * step)
  }

  /// The moment on the grid for a position.
  public func moment(at position: Double) -> Int {
    let seconds = position.isFinite ? max(0, position) : 0
    return min(last, Int(seconds) / step * step)
  }

  /// A new scrub: moments that failed get another try.
  public mutating func began() {
    failures = 0
    failed = []
  }

  /// The owner is at `position`: the moments to start reading now.
  public mutating func scrubbed(to position: Double) -> [Int] {
    if let wanted, position != wanted { direction = position > wanted ? 1 : -1 }
    wanted = position
    return next()
  }

  /// A read ended: the moments to start reading now.
  public mutating func finished(_ time: Int, _ outcome: Outcome) -> [Int] {
    reading.remove(time)
    switch outcome {
    case .loaded:
      loaded.insert(time)
      failures = 0
    case .busy:
      // Asked for again when the owner moves, not at once.
      return []
    case .failed:
      failed.insert(time)
      failures += 1
    }
    return next()
  }

  /// The owner stopped scrubbing: nothing more is wanted.
  public mutating func ended() {
    wanted = nil
  }

  /// A kept picture was let go, so its moment can be read again.
  public mutating func forget(_ time: Int) {
    loaded.remove(time)
  }

  /// The loaded moment nearest a position, within `reach` moments of it: a
  /// picture a little off shows until the exact one arrives.
  public func nearest(to position: Double, reach: Int = 12) -> Int? {
    let center = moment(at: position)
    if loaded.contains(center) { return center }
    for distance in 1...max(1, reach) {
      for time in [center - distance * step, center + distance * step] where loaded.contains(time) { return time }
    }
    return nil
  }

  private mutating func next() -> [Int] {
    guard let wanted, failures < Self.maxFailures else { return [] }
    // The moment itself, then the next one the way the owner moves.
    let center = moment(at: wanted)
    let ahead = min(last, max(0, center + direction * step))
    var started: [Int] = []
    for time in [center, ahead] where reading.count < Self.maxReads && !reading.contains(time) && !loaded.contains(time) && !failed.contains(time) {
      reading.insert(time)
      started.append(time)
    }
    return started
  }

  /// `/m/{token}/preview/{seconds}.jpg`, from the stream's `previews` path.
  public static func url(_ base: URL, time: Int) -> URL {
    base.appendingPathComponent("\(time).jpg")
  }
}

/// How far a swipe across the Siri Remote moves a scrub on the Apple TV.
public struct RemoteScrub: Sendable, Equatable {
  /// The translation a swipe over the whole touch surface reports.
  public static let surface = 1920.0

  public let start: Double
  public let end: Double

  public init(start: Double = 0, end: Double) {
    self.start = start
    self.end = max(start, end)
  }

  /// The seconds a whole swipe covers: a quarter of the video, between two
  /// and twenty minutes, so a film takes a few swipes and a short video stays
  /// fine-grained.
  public var span: Double {
    let length = end - start
    return min(length, min(1200, max(120, length / 4)))
  }

  /// The position `translation` points of swipe away from `base`.
  public func position(from base: Double, translation: Double) -> Double {
    clamped(base + translation / Self.surface * span)
  }

  public func clamped(_ position: Double) -> Double {
    min(end, max(start, position))
  }
}
