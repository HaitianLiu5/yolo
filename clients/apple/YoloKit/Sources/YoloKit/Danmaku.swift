import Foundation

// Danmaku: viewers' timed comments drawn over the picture (Agent Note
// 2026-10-13-danmaku), ported from the player's `danmaku-layout.js` so a
// comment lands in the same lane at the same moment on every screen. Only
// the text size differs: a TV is watched from across the room.

/// One timed comment, as `/m/{token}/comments` gives it.
public struct DanmakuComment: Sendable, Equatable {
  public let t: Double
  public let text: String
  /// `scroll`, `top`, or `bottom`.
  public let mode: String
  /// `#rrggbb`.
  public let color: String
  /// 0.5 to 2; above 1 takes two lanes.
  public let size: Double
  public let weight: Int?

  public init(t: Double, text: String, mode: String = "scroll", color: String = "#ffffff", size: Double = 1, weight: Int? = nil) {
    self.t = t
    self.text = text
    self.mode = mode
    self.color = color
    self.size = size
    self.weight = weight
  }

  public init?(json: JSONValue) {
    guard let t = json["t"]?.number, let text = json["text"]?.string else { return nil }
    self.init(
      t: t, text: text, mode: json["mode"]?.string ?? "scroll", color: json["color"]?.string ?? "#ffffff",
      size: json["size"]?.number ?? 1, weight: json["weight"]?.int
    )
  }
}

/// The screen's danmaku settings (`service/core/src/danmaku.js`).
public struct DanmakuSettings: Sendable, Equatable, Codable {
  public var enabled = true
  /// `low`, `normal`, or `high`.
  public var density = "normal"
  /// 0.2 to 1, in steps of 0.05.
  public var opacity = 0.8
  /// `full`, `half`, or `quarter` of the picture, from its top.
  public var area = "quarter"
  /// `small`, `normal`, or `large`.
  public var fontSize = "normal"

  public init() {}

  public static let densities = ["low", "normal", "high"]
  public static let areas = ["full", "half", "quarter"]
  public static let fontSizes = ["small", "normal", "large"]
  public static let opacities = [0.4, 0.6, 0.8, 1.0]

  /// The valid fields of a patch, as `danmakuSettingsPatch()` keeps them;
  /// the rest are dropped.
  public static func patch(_ json: JSONValue?) -> [String: JSONValue] {
    var patch: [String: JSONValue] = [:]
    guard let fields = json?.object else { return patch }
    if let enabled = fields["enabled"]?.bool { patch["enabled"] = .bool(enabled) }
    if let density = fields["density"]?.string, densities.contains(density) { patch["density"] = .string(density) }
    if let opacity = fields["opacity"]?.number, opacity.isFinite {
      patch["opacity"] = .number((min(1, max(0.2, opacity)) * 20).rounded() / 20)
    }
    if let area = fields["area"]?.string, areas.contains(area) { patch["area"] = .string(area) }
    if let fontSize = fields["fontSize"]?.string, fontSizes.contains(fontSize) { patch["fontSize"] = .string(fontSize) }
    return patch
  }

  public mutating func apply(_ patch: [String: JSONValue]) {
    if let value = patch["enabled"]?.bool { enabled = value }
    if let value = patch["density"]?.string { density = value }
    if let value = patch["opacity"]?.number { opacity = value }
    if let value = patch["area"]?.string { area = value }
    if let value = patch["fontSize"]?.string { fontSize = value }
  }

  /// A `danmaku` message's settings to apply, as the player's
  /// `danmakuToApply`: a live change goes whole; one sent `again` after a
  /// welcome skips each setting already applied from that change (`heard`,
  /// the id of the last change applied per setting) and each the owner
  /// changed here unheard (`own`).
  public static func toApply(_ message: RealtimeMessage, heard: [String: String], own: Set<String>) -> [String: JSONValue] {
    let settings = patch(message["settings"])
    guard message["again"]?.bool == true else { return settings }
    return settings.filter { name, _ in heard[name] != message.id && !own.contains(name) }
  }
}

/// Where comments go over the picture, as `danmakuGeometry()`.
public struct DanmakuGeometry: Sendable, Equatable {
  public let width: Double
  /// The area's height: the top fraction of the picture, less the inset.
  public let height: Double
  public let laneHeight: Double
  public let fontSize: Double
  /// From the picture's top to the first lane.
  public let inset: Double

  /// The TV's base text size: the player's 25 px read from a sofa.
  public static let tvFontSize = 36.0
  /// A phone's or tablet's, held in the hand: about the size Bilibili's app
  /// draws, smaller than the TV's so a picture a few hundred points tall
  /// still has lanes.
  public static let handheldFontSize = 21.0
  static let fontScale = ["small": 0.82, "normal": 1.0, "large": 1.2]
  static let areaFraction = ["full": 1.0, "half": 0.5, "quarter": 0.25]
  /// Kept free at the bottom while subtitles show.
  static let subtitleBand = 0.2
  static let topInset = 6.0 * 1.44

  /// `lineHeight(fontSize)` is the font's ink height for one line;
  /// `baseFontSize` is the device's normal text size.
  public init(
    width: Double, height: Double, settings: DanmakuSettings, subtitles: Bool, baseFontSize: Double = tvFontSize, lineHeight: (Double) -> Double
  ) {
    let fontSize = max(12, baseFontSize * (Self.fontScale[settings.fontSize] ?? 1))
    let fraction = min(Self.areaFraction[settings.area] ?? 1, subtitles ? 1 - Self.subtitleBand : 1)
    self.width = width
    self.fontSize = fontSize
    // The outline's 1 pt above and below, and 1 pt between lanes.
    laneHeight = (lineHeight(fontSize) + 2 + 1).rounded(.up)
    inset = Self.topInset
    self.height = max(1, (height * fraction).rounded(.down) - Self.topInset)
  }
}

/// A comment placed by the layout.
public struct PlacedComment: Sendable, Equatable {
  public let comment: DanmakuComment
  public let mode: String
  /// When it enters (may be after its time) and leaves.
  public let t: Double
  public let end: Double
  public let width: Double
  public let lane: Int
  public let speed: Double
}

/// The player's lane layout. Every position is a function of media time, so
/// a pause freezes the comments and a faster speed moves them faster.
public final class DanmakuLayout {
  static let fixedSeconds = 4.5
  static let maxActive = 200
  static let lowWeight = 3
  static let waitSeconds = ["low": 1.0, "normal": 1.0, "high": 2.0]
  static let entrySeconds = 1.0
  static let frameSeconds = 1.0 / 30
  static let waitStep = 1.0 / 15
  static let seekSeconds = 1.0
  static let backSeconds = 0.25
  static let replaySeconds = 16.0
  static let epsilon = 1e-6
  static let crossing: [(from: Double, seconds: Double)] = [
    (558, 7.1), (888, 8.1), (1082, 9.1), (1246, 10.1), (1452, 11.1), (1744, 13.1), (2314, 14.1), (2560, 16.1),
  ]

  private struct Item {
    var comment: DanmakuComment
    var mode: String
    var t: Double
    var end: Double
    var width: Double
    var span: Int
    var lane: Int
    var speed: Double
  }

  /// A comment's width at the geometry's text size.
  private let measure: (DanmakuComment, Double) -> Double
  private var comments: [DanmakuComment] = []
  public private(set) var geometry: DanmakuGeometry?
  private var density = "normal"
  private var active: [Item] = []
  private var lanes: [[Item]] = []
  private var lastTime: Double?
  private var origin: Double?
  private var stale = true
  private var next = 0
  private var lastStart = -Double.infinity
  private var lastLanes: ClosedRange<Int>?
  private var crossingSeconds = 8.0

  public init(measure: @escaping (DanmakuComment, Double) -> Double) {
    self.measure = measure
  }

  /// Seconds a scrolling comment takes to cross a picture `width` wide.
  public static func scrollSeconds(_ width: Double) -> Double {
    guard width >= crossing[0].from else { return 4.5 }
    if let index = crossing.indices.dropFirst().first(where: { width <= crossing[$0].from }) { return crossing[index - 1].seconds }
    let last = crossing[crossing.count - 1]
    return last.seconds + ((width - last.from) / 500).rounded(.down)
  }

  /// The player's hash (`hashOf`), Int32 arithmetic over UTF-16 code units.
  public static func hash(_ comment: DanmakuComment, seed: UInt32) -> UInt32 {
    var hash = Int32(truncatingIfNeeded: Int64((comment.t * 1000).rounded(.toNearestOrAwayFromZero))) ^ Int32(bitPattern: seed)
    for unit in comment.text.utf16 { hash = hash &* 31 &+ Int32(unit) }
    var h = UInt32(bitPattern: hash)
    h = UInt32(bitPattern: Int32(bitPattern: h ^ (h >> 16)) &* 0x45d9f3b)
    return h ^ (h >> 16)
  }

  static func span(_ comment: DanmakuComment) -> Int { min(2, max(1, Int((comment.size - 0.001).rounded(.up)))) }

  public func setComments(_ comments: [DanmakuComment]) {
    self.comments = comments
    next = lastTime.map { time in firstAtOrAfter(time + 1e-9) } ?? 0
  }

  public func setGeometry(_ geometry: DanmakuGeometry) {
    guard geometry != self.geometry else { return }
    self.geometry = geometry
    crossingSeconds = Self.scrollSeconds(geometry.width)
    stale = true
  }

  public func setDensity(_ density: String) {
    guard density != self.density else { return }
    self.density = density
    stale = true
  }

  /// A new item from `time`: nothing from before it shows.
  public func restart(at time: Double?) {
    origin = time
    lastTime = time
    stale = true
  }

  var laneCount: Int {
    guard let geometry, geometry.laneHeight > 0 else { return 0 }
    return max(0, Int((geometry.height / geometry.laneHeight + 1e-9).rounded(.down)))
  }

  var gap: Double { max(12, (geometry?.laneHeight ?? 0) / 2) }

  /// The comments placed by `time`, with their positions in the area.
  public func update(_ time: Double) -> [(comment: PlacedComment, x: Double, y: Double)] {
    guard let geometry else { return [] }
    let seek = lastTime.map { time < $0 - Self.backSeconds || time > $0 + Self.seekSeconds } ?? false
    var rebuilt = false
    if seek || origin == nil {
      origin = time
      rebuild(from: time)
      rebuilt = true
    } else if stale || lastTime == nil {
      rebuild(from: max(origin ?? time, time - Self.replaySeconds))
      rebuilt = true
    }
    while next < comments.count && comments[next].t <= time {
      place(comments[next])
      next += 1
    }
    prune(time)
    lastTime = rebuilt ? time : max(time, lastTime ?? time)
    return active.filter { $0.t <= time }.map { item in
      let x = item.mode == "scroll" ? geometry.width - (time - item.t) * item.speed : (geometry.width - item.width) / 2
      let placed = PlacedComment(comment: item.comment, mode: item.mode, t: item.t, end: item.end, width: item.width, lane: item.lane, speed: item.speed)
      return (placed, x, Double(item.lane) * geometry.laneHeight)
    }
  }

  private func firstAtOrAfter(_ time: Double) -> Int {
    var low = 0
    var high = comments.count
    while low < high {
      let middle = (low + high) / 2
      if comments[middle].t < time { low = middle + 1 } else { high = middle }
    }
    return low
  }

  private func rebuild(from time: Double) {
    stale = false
    active = []
    lanes = Array(repeating: [], count: laneCount)
    lastStart = -.infinity
    lastLanes = nil
    next = firstAtOrAfter(time)
  }

  private func prune(_ time: Double) {
    if active.contains(where: { time >= $0.end }) { active.removeAll { time >= $0.end } }
  }

  /// Where an item's left edge is at τ: p + q·τ.
  private func edge(_ item: Item) -> (p: Double, q: Double) {
    guard let geometry else { return (0, 0) }
    if item.mode != "scroll" { return ((geometry.width - item.width) / 2, 0) }
    return (geometry.width + item.t * item.speed, -item.speed)
  }

  /// Narrows `range` to where p + q·τ < 0.
  private func whereNegative(_ range: inout (low: Double, high: Double), _ p: Double, _ q: Double) {
    if abs(q) < 1e-12 {
      if p >= -Self.epsilon { range.high = -.infinity }
      return
    }
    let root = (-Self.epsilon - p) / q
    if q > 0 { range.high = min(range.high, root) } else { range.low = max(range.low, root) }
  }

  /// Whether two comments come closer than the gap while both show.
  private func meets(_ a: Item, _ b: Item) -> Bool {
    var range = (low: max(a.t, b.t), high: min(a.end, b.end))
    if range.high - range.low <= 1e-9 { return false }
    let left = edge(a)
    let right = edge(b)
    whereNegative(&range, left.p - right.p - b.width - gap, left.q - right.q)
    whereNegative(&range, right.p - left.p - a.width - gap, right.q - left.q)
    return range.high - range.low > 1e-9
  }

  private func fits(_ item: Item, lane: Int) -> Bool {
    for index in lane..<(lane + item.span) {
      for other in lanes[index] where meets(item, other) { return false }
    }
    return true
  }

  private func nextToLast(_ lane: Int, span: Int, start: Double) -> Bool {
    guard let last = lastLanes, start - lastStart < Self.entrySeconds else { return false }
    return lane <= last.upperBound + 1 && lane + span - 1 >= last.lowerBound - 1
  }

  func shows(_ comment: DanmakuComment) -> Bool {
    if density == "low" && Self.hash(comment, seed: 0) % 3 != 0 { return false }
    return density == "high" || !((comment.weight ?? Self.lowWeight) < Self.lowWeight)
  }

  private func place(_ comment: DanmakuComment) {
    guard shows(comment), let geometry else { return }
    prune(comment.t)
    guard active.count < Self.maxActive else { return }
    let count = laneCount
    let mode = comment.mode == "top" || comment.mode == "bottom" ? comment.mode : "scroll"
    let span = min(Self.span(comment), count)
    guard span > 0 else { return }
    let width = measure(comment, geometry.fontSize)
    let duration = mode == "scroll" ? crossingSeconds : Self.fixedSeconds
    var item = Item(
      comment: comment, mode: mode, t: comment.t, end: comment.t + duration, width: width, span: span, lane: -1,
      speed: mode == "scroll" ? (geometry.width + width) / duration : 0
    )
    for index in lanes.indices where lanes[index].first.map({ $0.end <= comment.t }) ?? false {
      lanes[index].removeAll { $0.end <= comment.t }
    }
    let variation = 0.5 + Double(Self.hash(comment, seed: 0x5bd1e995) % 1024) / 1024
    let spacing = max(Self.frameSeconds, (Self.entrySeconds / Double(count)) * variation)
    let latest = comment.t + (Self.waitSeconds[density] ?? 1) + 1e-9
    var start = max(comment.t, lastStart + spacing)
    while start <= latest {
      item.t = start
      item.end = start + duration
      var chosen = -1
      var step = 0
      while step + span <= count {
        let lane = mode == "bottom" ? count - span - step : step
        step += 1
        guard fits(item, lane: lane) else { continue }
        if !nextToLast(lane, span: span, start: start) {
          chosen = lane
          break
        }
        if chosen < 0 { chosen = lane }
      }
      if chosen >= 0 {
        item.lane = chosen
        for index in chosen..<(chosen + span) { lanes[index].append(item) }
        active.append(item)
        lastStart = start
        lastLanes = chosen...(chosen + span - 1)
        return
      }
      start += Self.waitStep
    }
  }
}

/// Which 360-second windows of comments to fetch, as the player's
/// `danmaku.js`: the window at the position, and the next once the position
/// is in the last 30 seconds of it.
public enum DanmakuWindows {
  public static let seconds = 360.0
  public static let prefetch = 30.0
  public static let retry: Duration = .seconds(30)
  public static let kept = 8

  public static func needed(at time: Double) -> [Int] {
    let index = Int((max(0, time) / seconds).rounded(.down))
    let next = time >= Double(index + 1) * seconds - prefetch
    return next ? [index, index + 1] : [index]
  }

  /// `/m/{token}/comments?start=&end=` for window `index`.
  public static func url(_ base: URL, index: Int) -> URL {
    var components = URLComponents(url: base, resolvingAgainstBaseURL: true)!
    components.queryItems = [
      URLQueryItem(name: "start", value: String(Int(Double(index) * seconds))),
      URLQueryItem(name: "end", value: String(Int(Double(index + 1) * seconds))),
    ]
    return components.url!
  }
}
