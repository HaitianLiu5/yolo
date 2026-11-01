import Observation
import QuartzCore
import UIKit
import YoloKit

/// The screen's danmaku (Agent Note 2026-10-13-danmaku): its settings, kept
/// on this screen, the comments of the item playing, fetched in 360-second
/// windows around the position, and the layout YoloKit ports from the player.
@MainActor @Observable
final class Danmaku {
  private(set) var settings: DanmakuSettings
  /// The item has comments, so the menu offers them.
  private(set) var available = false

  @ObservationIgnored let layout: DanmakuLayout
  @ObservationIgnored private var comments: [Int: [DanmakuComment]] = [:]
  @ObservationIgnored private var loading: Set<Int> = []
  @ObservationIgnored private var failedAt: [Int: ContinuousClock.Instant] = [:]
  @ObservationIgnored private var base: URL?
  @ObservationIgnored private var item: String?
  /// Bumped when the settings change, so the view lays out again.
  private(set) var version = 0
  /// Comments drawn now, for the conformance kit's debug state.
  @ObservationIgnored var onScreen = 0

  private static let defaultsKey = "yolo.danmaku"
  private static let font = "PingFangSC-Semibold"

  /// False for a conformance run, which starts from the defaults and keeps nothing.
  @ObservationIgnored private let persist: Bool

  init(persist: Bool = true) {
    self.persist = persist
    var settings = DanmakuSettings()
    if persist, let stored = UserDefaults.standard.data(forKey: Self.defaultsKey), let patch = try? JSONValue.parse(stored) {
      settings.apply(DanmakuSettings.patch(patch))
    }
    self.settings = settings
    layout = DanmakuLayout { comment, fontSize in
      Danmaku.width(of: comment.text, size: fontSize * comment.size)
    }
  }

  static func uiFont(_ size: Double) -> UIFont {
    UIFont(name: font, size: size) ?? .systemFont(ofSize: size, weight: .semibold)
  }

  static func width(of text: String, size: Double) -> Double {
    ceil((text as NSString).size(withAttributes: [.font: uiFont(size)]).width) + 2
  }

  static func lineHeight(_ size: Double) -> Double {
    let font = uiFont(size)
    return ceil(font.ascender - font.descender)
  }

  /// Applies a patch from the owner or an agent, keeping only the settings
  /// ever chosen here, so one never chosen follows a new default.
  func update(_ patch: [String: JSONValue]) {
    guard !patch.isEmpty else { return }
    settings.apply(patch)
    layout.setDensity(settings.density)
    version += 1
    guard persist else { return }
    var stored = (UserDefaults.standard.data(forKey: Self.defaultsKey).flatMap { try? JSONValue.parse($0) })?.object ?? [:]
    for (name, value) in patch { stored[name] = value }
    UserDefaults.standard.set(JSONValue.object(stored).encoded(), forKey: Self.defaultsKey)
  }

  /// A new stream: the same item keeps its windows, another starts over.
  func load(_ stream: StreamDescriptor, item: JSONValue?, server: ServerAddress, startTime: Double) {
    let key = item?["source"].map { $0.encodedString() }
    base = stream.isLive ? nil : stream.comments.flatMap { stream.resolve($0, server: server) }
    if key != self.item {
      self.item = key
      comments = [:]
      loading = []
      failedAt = [:]
      available = false
      layout.setComments([])
      layout.restart(at: startTime)
    }
    if base == nil { available = false }
    layout.setDensity(settings.density)
  }

  func clear() {
    base = nil
    item = nil
    comments = [:]
    available = false
    layout.setComments([])
  }

  /// Fetches what the position needs: its window, and the next near its end.
  func ensureWindows(at time: Double) {
    guard let base else { return }
    for index in DanmakuWindows.needed(at: time) where comments[index] == nil && !loading.contains(index) {
      if let failed = failedAt[index], ContinuousClock.now - failed < DanmakuWindows.retry { continue }
      loading.insert(index)
      let url = DanmakuWindows.url(base, index: index)
      Task {
        defer { loading.remove(index) }
        guard let (data, response) = try? await URLSession.shared.data(from: url),
              let status = (response as? HTTPURLResponse)?.statusCode, self.base == base
        else {
          failedAt[index] = .now
          return
        }
        if status == 404 { return }
        guard status == 200, let body = try? JSONValue.parse(data) else {
          failedAt[index] = .now
          return
        }
        if body["available"]?.bool == false { return }
        available = true
        if body["complete"]?.bool == false { failedAt[index] = .now }
        comments[index] = (body["comments"]?.array ?? []).compactMap(DanmakuComment.init(json:))
        // Drop the windows farthest from this one.
        while comments.count > DanmakuWindows.kept, let far = comments.keys.max(by: { abs($0 - index) < abs($1 - index) }) {
          comments[far] = nil
        }
        layout.setComments(comments.keys.sorted().flatMap { comments[$0] ?? [] })
      }
    }
  }
}

/// Draws the comments over the picture, one text layer each, moved every
/// frame from the media time, so a pause freezes them and a faster speed
/// moves them faster.
final class DanmakuView: UIView {
  var danmaku: Danmaku?
  var time: () -> Double = { 0 }
  var subtitles: () -> Bool = { false }
  /// The video's rect in this view's coordinates.
  var picture: () -> CGRect = { .zero }
  /// The device's normal text size (DanmakuGeometry).
  var baseFontSize = DanmakuGeometry.tvFontSize

  private var link: CADisplayLink?
  private var layers: [String: CATextLayer] = [:]
  private var laidOutVersion = -1

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    link?.invalidate()
    link = nil
    if window != nil {
      let link = CADisplayLink(target: self, selector: #selector(frame(_:)))
      link.add(to: .main, forMode: .common)
      self.link = link
    }
  }

  @objc private func frame(_ link: CADisplayLink) {
    MainActor.assumeIsolated { draw() }
  }

  @MainActor private func draw() {
    let now = time()
    // Comments are fetched while danmaku is on, so the item's first window
    // tells whether it has any.
    if let danmaku, danmaku.settings.enabled { danmaku.ensureWindows(at: now) }
    guard let danmaku, danmaku.settings.enabled, danmaku.available else {
      clear()
      return
    }
    let rect = picture()
    guard rect.width > 0, bounds.width > 0 else { return }
    // Comments cross the whole screen, entering at its right edge rather
    // than the picture's, which a narrower picture leaves mid-screen; their
    // lanes follow the picture's height.
    let geometry = DanmakuGeometry(
      width: bounds.width, height: rect.height, settings: danmaku.settings, subtitles: subtitles(), baseFontSize: baseFontSize,
      lineHeight: Danmaku.lineHeight
    )
    danmaku.layout.setGeometry(geometry)
    if laidOutVersion != danmaku.version {
      laidOutVersion = danmaku.version
      clear()
    }
    let placed = danmaku.layout.update(now)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    layer.opacity = Float(danmaku.settings.opacity)
    var seen = Set<String>()
    for entry in placed {
      let comment = entry.comment.comment
      let key = "\(entry.comment.t)|\(comment.text)"
      seen.insert(key)
      let text = layers[key] ?? makeLayer(comment, fontSize: geometry.fontSize)
      layers[key] = text
      let height = Danmaku.lineHeight(geometry.fontSize * comment.size) + 2
      text.frame = CGRect(
        x: bounds.minX + entry.x, y: rect.minY + geometry.inset + entry.y + (geometry.laneHeight - height) / 2,
        width: entry.comment.width, height: height
      )
    }
    for (key, text) in layers where !seen.contains(key) {
      text.removeFromSuperlayer()
      layers[key] = nil
    }
    CATransaction.commit()
    danmaku.onScreen = layers.count
  }

  @MainActor private func makeLayer(_ comment: DanmakuComment, fontSize: Double) -> CATextLayer {
    let text = CATextLayer()
    let size = fontSize * comment.size
    let color = Self.color(comment.color)
    text.string = NSAttributedString(string: comment.text, attributes: [.font: Danmaku.uiFont(size), .foregroundColor: color])
    text.contentsScale = window?.screen.scale ?? 2
    text.alignmentMode = .left
    // The player's outline: a dark shadow, or a light one for dark text.
    var white: CGFloat = 0
    color.getWhite(&white, alpha: nil)
    text.shadowColor = (white < 60.0 / 255 ? UIColor.white : UIColor.black).cgColor
    text.shadowOpacity = 1
    text.shadowRadius = 1.5
    text.shadowOffset = .zero
    layer.addSublayer(text)
    return text
  }

  @MainActor private func clear() {
    layers.values.forEach { $0.removeFromSuperlayer() }
    layers = [:]
    danmaku?.onScreen = 0
  }

  static func color(_ hex: String) -> UIColor {
    let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    guard digits.count == 6, let value = Int(digits, radix: 16) else { return .white }
    return UIColor(red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255, blue: CGFloat(value & 0xff) / 255, alpha: 1)
  }
}
