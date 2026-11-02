import Foundation

/// Adaptive quality (Agent Note 2026-10-11-adaptive-quality), as the
/// player's `quality.js`: the screen lowers its video bitrate cap when the
/// connection cannot carry the stream, and raises it again, one rung at a
/// time, once it comfortably can. A cap change is a new stream
/// (`reason: "quality"`, `maxVideoKbps`), which the Hub keeps for this
/// device and the media path the request names, as where its next stream
/// there starts.
public struct QualityController: Sendable {
  public static let ladder: [Int] = [400, 700, 1000, 1500, 2200, 3000, 4000, 6000, 9000, 13000]
  static let requiredHeadroom = 1.15
  static let downSafety = 0.75
  static let downAfterBuffering = 8.0
  static let downAfterDraining = 20.0
  static let downCooldown = 20.0
  static let lowBuffer = 20.0
  static let healthyBuffer = 30.0
  static let upHeadroom = 1.6
  static let upSustain = 90.0
  static let upMinAfterDown = 120.0
  static let upMaxSustain = 900.0
  static let oscillationWindow = 300.0
  static let penaltyReset = 1800.0
  static let minSamples = 2
  static let upMinSamples = 3
  static let defaultAudioKbps = 128.0
  static let staleSample = 30.0
  static let minRemaining = 20.0
  static let pendingTimeout = 60.0

  /// One measurement, about every second.
  public struct Sample: Sendable {
    public var throughputKbps: Double
    public var sampleCount: Int
    public var bufferedAhead: Double
    public var buffering: Bool
    /// The stream switches variants by itself (a multi-variant playlist).
    public var adaptive: Bool
    public var downloading: Bool
    public var sampleAge: Double?
    /// Nil for a live stream.
    public var remaining: Double?
    public var restBuffered: Bool
    public var rate: Double

    public init(
      throughputKbps: Double, sampleCount: Int, bufferedAhead: Double, buffering: Bool, adaptive: Bool = false,
      downloading: Bool = true, sampleAge: Double? = nil, remaining: Double?, restBuffered: Bool = false, rate: Double = 1
    ) {
      self.throughputKbps = throughputKbps
      self.sampleCount = sampleCount
      self.bufferedAhead = bufferedAhead
      self.buffering = buffering
      self.adaptive = adaptive
      self.downloading = downloading
      self.sampleAge = sampleAge
      self.remaining = remaining
      self.restBuffered = restBuffered
      self.rate = rate
    }
  }

  public enum Decision: Sendable, Equatable {
    case keep
    /// Ask for a new stream with this cap; nil lifts it.
    case change(maxVideoKbps: Int?)
  }

  /// Whether a stream reported its limits: until then a rebuild leaves the
  /// cap out and the Hub uses what it remembers.
  public private(set) var known = false
  public private(set) var cap: Int?
  private var ceiling: Double?
  private var videoKbps: Double?
  private var audioKbps = defaultAudioKbps
  private var live = false
  private var floor: Double?
  private var item: String?
  private var startedAt = 0.0
  private var insufficientSince: Double?
  private var bufferingSince: Double?
  private var comfortableSince: Double?
  private var lastDownAt: Double?
  private var lastUpAt: Double?
  private var sustain = upSustain
  private var pending: (at: Double, down: Bool, from: Double?)?

  /// The owner's own cap, which adaptive quality leaves alone until the
  /// owner goes back to Auto: nil for Auto, `.some(nil)` for the most the
  /// media path carries.
  public private(set) var chosen: Int??

  public init() {}

  /// What a rebuild sends as `maxVideoKbps`: nil to leave it out (unknown),
  /// `.some(nil)` to say "no cap".
  public var requestCap: Int?? {
    if let chosen { return .some(chosen) }
    return known ? .some(cap) : nil
  }

  /// The rungs worth offering the owner: those under the path's ceiling.
  public var choices: [Int] {
    Self.ladder.filter { rung in ceiling.map { $0 <= 0 || Double(rung) < $0 } ?? true }
  }

  /// The owner chose a cap (`.some`), or Auto (nil). A cap is a new stream
  /// at it, which the caller asks for; Auto goes on from what plays.
  public mutating func choose(_ cap: Int??) {
    chosen = cap
    pending = nil
    insufficientSince = nil
    bufferingSince = nil
    comfortableSince = nil
    if let cap {
      known = true
      self.cap = cap
    }
  }

  /// A new stream's `limits` and `profile`, at `now` (seconds).
  public mutating func load(limits: JSONValue?, profile: JSONValue?, isLive: Bool, item: String?, now: Double) {
    if item != self.item { floor = nil }
    if let pending, pending.down, let from = pending.from, let video = profile?["videoKbps"]?.number, video >= from * 0.95 {
      // The step down gave no lower bitrate: no point asking again on this item.
      floor = video
    }
    self.item = item
    pending = nil
    if let limits, limits.object != nil {
      known = true
      ceiling = limits["ceilingKbps"]?.number
      cap = limits["capped"]?.bool == true ? limits["maxVideoKbps"]?.int : nil
    }
    videoKbps = profile?["videoKbps"]?.number
    audioKbps = profile?["audioKbps"]?.number ?? Self.defaultAudioKbps
    live = isLive
    startedAt = now
    insufficientSince = nil
    bufferingSince = nil
    comfortableSince = nil
  }

  /// A requested stream never came, or was refused.
  public mutating func abandon() {
    pending = nil
  }

  public mutating func observe(_ sample: Sample, now: Double) -> Decision {
    if let pending, now - pending.at > Self.pendingTimeout { self.pending = nil }
    guard chosen == nil, pending == nil, !live, let video = videoKbps else { return .keep }
    if sample.restBuffered || (sample.remaining.map { $0 < Self.minRemaining } ?? false) { return .keep }
    if let age = sample.sampleAge, age > Self.staleSample, !sample.downloading { return .keep }
    if let lastDownAt, now - lastDownAt > Self.penaltyReset { sustain = Self.upSustain }
    let speed = max(1, sample.rate)

    // Down.
    bufferingSince = sample.buffering ? (bufferingSince ?? now) : nil
    let insufficient = sample.sampleCount >= Self.minSamples && sample.throughputKbps > 0
      && sample.throughputKbps < (video + audioKbps) * speed * Self.requiredHeadroom
      && (sample.buffering || sample.bufferedAhead < Self.lowBuffer)
    insufficientSince = insufficient ? (insufficientSince ?? now) : nil
    if insufficient {
      let stalled = bufferingSince.map { now - $0 >= Self.downAfterBuffering } ?? false
      let draining = !sample.adaptive && (insufficientSince.map { now - $0 >= Self.downAfterDraining } ?? false)
      let cooled = lastDownAt.map { now - $0 >= Self.downCooldown } ?? true
      if (stalled || draining) && cooled, let target = downTarget(sample, video: video, speed: speed) {
        if let lastUpAt, now - lastUpAt < Self.oscillationWindow { sustain = min(Self.upMaxSustain, sustain * 2) }
        lastDownAt = now
        pending = (now, true, video)
        cap = target
        return .change(maxVideoKbps: target)
      }
      comfortableSince = nil
      return .keep
    }

    // Up.
    guard let current = cap else { return .keep }
    // Past the ladder, or at the node's ceiling: no device cap at all.
    let next = Self.ladder.first { $0 > current }
    let top = ceiling.flatMap { $0 > 0 ? $0 : nil }
    let target: Int? = next.flatMap { rung in top.map { Double(rung) >= $0 } ?? false ? nil : rung }
    let need = (target.map(Double.init) ?? top ?? max(Double(current) * 1.5, Double(Self.ladder[Self.ladder.count - 1]))) + audioKbps
    let comfortable = sample.sampleCount >= Self.upMinSamples && !sample.buffering && sample.bufferedAhead >= Self.healthyBuffer
      && sample.throughputKbps >= need * speed * Self.upHeadroom
    guard comfortable else {
      comfortableSince = nil
      return .keep
    }
    let since = comfortableSince ?? now
    comfortableSince = since
    let held = now - since >= sustain && now - startedAt >= sustain
    let afterDown = lastDownAt.map { now - $0 >= Self.upMinAfterDown } ?? true
    guard held && afterDown else { return .keep }
    lastUpAt = now
    pending = (now, false, nil)
    cap = target
    comfortableSince = nil
    return .change(maxVideoKbps: target)
  }

  private func downTarget(_ sample: Sample, video: Double, speed: Double) -> Int? {
    if let floor, video <= floor * 1.05 { return nil }
    let budget = (sample.throughputKbps * Self.downSafety / speed - audioKbps).rounded(.down)
    var rung = Self.ladder.last { Double($0) <= budget } ?? Self.ladder[0]
    if Double(rung) >= video * 0.85 {
      let limit = min(video * 0.85, Double(rung))
      guard let lower = Self.ladder.last(where: { Double($0) < limit }) else { return nil }
      rung = lower
    }
    if let cap, rung >= cap { return nil }
    return rung
  }
}
