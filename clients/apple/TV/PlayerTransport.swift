import AVKit
import UIKit
import YoloKit

/// The player on the Apple TV: AVPlayerViewController shows the picture and
/// keeps Now Playing, and this draws the controls, because AVKit's transport
/// bar takes no pictures from an app while it scrubs
/// (Agent Note 2026-11-07-scrub-previews).
///
/// A swipe left or right scrubs, with the moment's picture over the timeline,
/// and a click there seeks; Back returns to where it was. A click pauses and
/// plays, an edge of the touch surface skips ten seconds, and a swipe down
/// reaches the menus. Back hides the controls, then leaves.
final class PlayerController: UIViewController {
  let video = AVPlayerViewController()
  private let playback: Player
  private let previews: ScrubPreviews
  private let seek: (Double) -> Void
  private let close: () -> Void

  /// Takes the remote's presses and swipes while no menu has focus.
  private let surface = RemoteSurface()
  private let controls = UIView()
  private let shade = GradientView()
  private let titleLabel = UILabel()
  private let subtitleLabel = UILabel()
  private let timeline = TransportTimeline()
  private let elapsedLabel = UILabel()
  private let remainingLabel = UILabel()
  private let menus = UIStackView()
  private let upGuide = UIFocusGuide()
  private let card = ScrubCard()
  private let spinner = UIActivityIndicatorView(style: .large)

  /// Where a scrub stands, and whether it returns to playing.
  private var scrub: (position: Double, resumes: Bool)?
  private var panBase = 0.0
  /// A vertical swipe acted: the rest of it does nothing.
  private var panSpent = false
  private var menuFocused = false
  private var hideAt: ContinuousClock.Instant?
  private var refresher: Task<Void, Never>?
  private var menuItems: [UIMenuElement] = []
  private var menuSignature = ""

  private static let speeds: [Float] = [0.5, 0.75, 1, 1.25, 1.5, 2]
  private static let skip = 10.0
  private static let margin: CGFloat = 90
  private static let shownFor: Duration = .seconds(4)

  init(playback: Player, previews: ScrubPreviews, seek: @escaping (Double) -> Void, close: @escaping () -> Void) {
    self.playback = playback
    self.previews = previews
    self.seek = seek
    self.close = close
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    video.player = playback.player
    video.showsPlaybackControls = false
    addChild(video)
    video.view.frame = view.bounds
    video.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    video.view.isUserInteractionEnabled = false
    view.addSubview(video.view)
    video.didMove(toParent: self)

    surface.frame = view.bounds
    surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(surface)
    addRecognizers()
    buildControls()
    spinner.color = .white
    spinner.hidesWhenStopped = true
    view.addSubview(spinner)
    setControls(shown: false, animated: false)
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    refresher = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(100))
        self?.refresh()
      }
    }
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    refresher?.cancel()
    refresher = nil
  }

  override var preferredFocusEnvironments: [UIFocusEnvironment] {
    menuFocused ? [menus] : [surface]
  }

  override func didUpdateFocus(in context: UIFocusUpdateContext, with coordinator: UIFocusAnimationCoordinator) {
    super.didUpdateFocus(in: context, with: coordinator)
    let inMenus = context.nextFocusedView?.isDescendant(of: menus) == true
    if inMenus != menuFocused {
      menuFocused = inMenus
      showControlsForAWhile()
    }
  }

  // MARK: The remote

  private func addRecognizers() {
    let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
    pan.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirect.rawValue)]
    surface.addGestureRecognizer(pan)
    let presses: [(UIPress.PressType, Selector)] = [
      (.select, #selector(selected)), (.playPause, #selector(playPaused)),
      (.leftArrow, #selector(leftPressed)), (.rightArrow, #selector(rightPressed)),
      (.upArrow, #selector(upPressed)), (.downArrow, #selector(downPressed)),
    ]
    for (type, action) in presses {
      let tap = UITapGestureRecognizer(target: self, action: action)
      tap.allowedPressTypes = [NSNumber(value: type.rawValue)]
      surface.addGestureRecognizer(tap)
    }
    // On the whole screen: Back also leaves the menus.
    let back = UITapGestureRecognizer(target: self, action: #selector(backPressed))
    back.allowedPressTypes = [NSNumber(value: UIPress.PressType.menu.rawValue)]
    view.addGestureRecognizer(back)
  }

  /// The range the timeline shows: the item, or what a live stream can seek.
  private var range: RemoteScrub? {
    if let duration = playback.duration, duration > 0 { return RemoteScrub(end: duration) }
    guard let seekable = playback.player.currentItem?.seekableTimeRanges.last?.timeRangeValue,
          seekable.duration.seconds > 60
    else { return nil }
    return RemoteScrub(start: seekable.start.seconds, end: seekable.end.seconds)
  }

  @objc private func panned(_ pan: UIPanGestureRecognizer) {
    let moved = pan.translation(in: view)
    switch pan.state {
    case .began:
      panSpent = false
      panBase = scrub?.position ?? 0
    case .changed:
      guard !panSpent else { return }
      if scrub != nil, let range {
        moveScrub(to: range.position(from: panBase, translation: moved.x))
      } else if abs(moved.x) > 40, abs(moved.x) > abs(moved.y) * 1.5, range != nil {
        beginScrub()
        panBase = scrub?.position ?? 0
        pan.setTranslation(.zero, in: view)
      } else if moved.y > 60, abs(moved.y) > abs(moved.x) * 1.5 {
        panSpent = true
        focusMenus()
      } else if moved.y < -60, abs(moved.y) > abs(moved.x) * 1.5 {
        panSpent = true
        showControlsForAWhile()
      }
    default:
      break
    }
  }

  private func beginScrub() {
    let resumes = playback.isPlaying
    // The picture holds still while the owner looks for a moment.
    if resumes { playback.player.pause() }
    scrub = (position: playback.position, resumes: resumes)
    previews.began()
    hideAt = nil
    setControls(shown: true, animated: true)
    refresh()
  }

  private func moveScrub(to position: Double) {
    guard scrub != nil else { return }
    scrub?.position = position
    if let duration = playback.duration { previews.scrub(to: position, duration: duration) }
    refresh()
  }

  /// A click: goes to the moment; Back leaves it instead.
  private func endScrub(seeking: Bool, play: Bool? = nil) {
    guard let scrub else { return }
    self.scrub = nil
    previews.ended()
    if seeking { seek(scrub.position) }
    if play ?? scrub.resumes { playback.player.play() }
    showControlsForAWhile()
  }

  @objc private func selected() {
    if scrub != nil { endScrub(seeking: true) } else { togglePlaying() }
  }

  @objc private func playPaused() {
    if scrub != nil { endScrub(seeking: true, play: true) } else { togglePlaying() }
  }

  private func togglePlaying() {
    if playback.isPlaying { playback.player.pause() } else { playback.player.play() }
    showControlsForAWhile()
  }

  @objc private func leftPressed() { skip(by: -Self.skip) }
  @objc private func rightPressed() { skip(by: Self.skip) }

  private func skip(by seconds: Double) {
    guard let range else { return }
    if let scrub {
      moveScrub(to: range.clamped(scrub.position + seconds))
      return
    }
    seek(range.clamped(playback.position + seconds))
    showControlsForAWhile()
  }

  @objc private func upPressed() {
    if scrub == nil { showControlsForAWhile() }
  }

  @objc private func downPressed() {
    if scrub == nil { focusMenus() }
  }

  @objc private func backPressed() {
    if scrub != nil {
      endScrub(seeking: false)
    } else if menuFocused {
      menuFocused = false
      setNeedsFocusUpdate()
      updateFocusIfNeeded()
      showControlsForAWhile()
    } else if !controls.isHidden {
      setControls(shown: false, animated: true)
    } else {
      close()
    }
  }

  private func focusMenus() {
    guard !menus.arrangedSubviews.isEmpty else { return }
    setControls(shown: true, animated: true)
    menuFocused = true
    setNeedsFocusUpdate()
    updateFocusIfNeeded()
  }

  private func showControlsForAWhile() {
    setControls(shown: true, animated: true)
    hideAt = .now + Self.shownFor
  }

  private func setControls(shown: Bool, animated: Bool) {
    if !shown { hideAt = nil }
    guard shown == controls.isHidden || !animated else { return }
    if shown { controls.isHidden = false }
    let change = { self.controls.alpha = shown ? 1 : 0 }
    guard animated else {
      change()
      controls.isHidden = !shown
      return
    }
    UIView.animate(withDuration: 0.2, animations: change) { _ in
      self.controls.isHidden = self.controls.alpha == 0
    }
  }

  // MARK: Drawing

  private func buildControls() {
    controls.frame = view.bounds
    controls.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    controls.isUserInteractionEnabled = true
    view.addSubview(controls)
    shade.autoresizingMask = [.flexibleWidth, .flexibleTopMargin]
    controls.addSubview(shade)
    for (label, font) in [
      (titleLabel, UIFont.systemFont(ofSize: 44, weight: .semibold)),
      (subtitleLabel, UIFont.systemFont(ofSize: 28, weight: .medium)),
      (elapsedLabel, UIFont.monospacedDigitSystemFont(ofSize: 26, weight: .medium)),
      (remainingLabel, UIFont.monospacedDigitSystemFont(ofSize: 26, weight: .medium)),
    ] {
      label.font = font
      label.textColor = .white
      controls.addSubview(label)
    }
    subtitleLabel.alpha = 0.8
    elapsedLabel.alpha = 0.8
    remainingLabel.alpha = 0.8
    remainingLabel.textAlignment = .right
    controls.addSubview(timeline)
    menus.axis = .horizontal
    menus.spacing = 8
    controls.addSubview(menus)
    controls.addSubview(card)
    // From the menus, up returns to the picture.
    view.addLayoutGuide(upGuide)
    upGuide.preferredFocusEnvironments = [surface]
    NSLayoutConstraint.activate([
      upGuide.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      upGuide.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      upGuide.topAnchor.constraint(equalTo: view.topAnchor, constant: 400),
      upGuide.heightAnchor.constraint(equalToConstant: 40),
    ])
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let bounds = view.bounds
    let margin = Self.margin
    let width = bounds.width - margin * 2
    shade.frame = CGRect(x: 0, y: bounds.height - 480, width: bounds.width, height: 480)
    menus.frame = CGRect(x: margin - 8, y: bounds.height - 130, width: width, height: 70)
    menus.distribution = .fill
    menus.isLayoutMarginsRelativeArrangement = false
    let lineY = bounds.height - 200
    timeline.frame = CGRect(x: margin, y: lineY, width: width, height: 12)
    elapsedLabel.frame = CGRect(x: margin, y: lineY + 18, width: 300, height: 34)
    remainingLabel.frame = CGRect(x: bounds.maxX - margin - 300, y: lineY + 18, width: 300, height: 34)
    titleLabel.frame = CGRect(x: margin, y: lineY - 70, width: width, height: 54)
    subtitleLabel.frame = CGRect(x: margin, y: lineY - 108, width: width, height: 36)
    spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
    positionCard()
  }

  private func refresh() {
    let status = playback.status
    if playback.current == nil || status == .loading || status == .buffering {
      if !spinner.isAnimating { spinner.startAnimating() }
    } else if spinner.isAnimating {
      spinner.stopAnimating()
    }
    if let hideAt, .now >= hideAt, scrub == nil, !menuFocused, playback.isPlaying {
      setControls(shown: false, animated: true)
    }
    guard !controls.isHidden else { return }
    titleLabel.text = playback.title
    subtitleLabel.text = playback.subtitle
    let range = range
    let position = playback.position
    let start = range?.start ?? 0
    let length = range.map { $0.end - $0.start } ?? 0
    let fraction = { (time: Double) in length > 0 ? CGFloat(min(1, max(0, (time - start) / length))) : 0 }
    timeline.isHidden = range == nil
    timeline.played = fraction(position)
    timeline.buffered = playback.bufferedEnd.map(fraction)
    timeline.scrubbed = scrub.map { fraction($0.position) }
    let shown = scrub?.position ?? position
    if playback.duration != nil {
      elapsedLabel.text = Self.clock(shown)
      remainingLabel.text = "-" + Self.clock(max(0, (range?.end ?? 0) - shown))
    } else {
      elapsedLabel.text = "LIVE"
      remainingLabel.text = range.map { "-" + Self.clock(max(0, $0.end - shown)) }
    }
    card.isHidden = scrub == nil
    if let scrub {
      card.showsPicture = previews.available
      card.set(image: previews.image(near: scrub.position), time: playback.duration != nil ? Self.clock(scrub.position) : "-" + Self.clock(max(0, (range?.end ?? 0) - scrub.position)))
      positionCard()
    }
  }

  /// Over the moment on the timeline, kept inside the margins.
  private func positionCard() {
    guard let played = timeline.scrubbed else { return }
    let size = card.size(for: playback.player.currentItem?.presentationSize)
    let line = timeline.frame
    let x = min(max(line.minX, line.minX + line.width * played - size.width / 2), line.maxX - size.width)
    card.frame = CGRect(x: x, y: line.minY - size.height - 24, width: size.width, height: size.height)
  }

  static func clock(_ seconds: Double) -> String {
    let total = Int(seconds.isFinite ? max(0, seconds) : 0)
    return total >= 3600
      ? String(format: "%d:%02d:%02d", total / 3600, total / 60 % 60, total % 60)
      : String(format: "%d:%02d", total / 60, total % 60)
  }

  // MARK: Menus

  /// The menus from Yolo's state; unchanged ones keep what is open and focused.
  func setMenus(_ items: [UIMenuElement]) {
    menuItems = items
    applyMenus()
  }

  private var speedMenu: UIMenu {
    let current = playback.player.defaultRate
    return UIMenu(title: "Speed", image: UIImage(systemName: "gauge.with.dots.needle.33percent"), options: .singleSelection, children: Self.speeds.map { speed in
      UIAction(title: speed == 1 ? "Normal" : "\(speed.formatted())×", state: speed == current ? .on : .off) { [weak self] _ in
        guard let self else { return }
        self.playback.player.defaultRate = speed
        if self.playback.isPlaying { self.playback.player.rate = speed }
        self.applyMenus()
      }
    })
  }

  private func applyMenus() {
    let items = menuItems + [speedMenu]
    let signature = items.map(Self.signature).joined(separator: "|")
    guard signature != menuSignature else { return }
    let sameButtons = items.map(\.title) == menus.arrangedSubviews.map { ($0 as? UIButton)?.configuration?.title ?? "" }
    menuSignature = signature
    if sameButtons {
      for (item, view) in zip(items, menus.arrangedSubviews) {
        if let button = view as? UIButton, let menu = item as? UIMenu { button.menu = menu }
      }
      return
    }
    menus.arrangedSubviews.forEach { $0.removeFromSuperview() }
    for item in items { menus.addArrangedSubview(Self.button(for: item)) }
    menus.addArrangedSubview(UIView())
  }

  private static func button(for item: UIMenuElement) -> UIButton {
    var configuration = UIButton.Configuration.plain()
    configuration.title = item.title
    configuration.image = item.image
    configuration.imagePadding = 10
    configuration.baseForegroundColor = .white
    let button: UIButton
    if let action = item as? UIAction {
      button = UIButton(configuration: configuration, primaryAction: action)
    } else {
      button = UIButton(configuration: configuration)
      button.menu = item as? UIMenu
      button.showsMenuAsPrimaryAction = true
    }
    return button
  }

  private static func signature(_ item: UIMenuElement) -> String {
    if let menu = item as? UIMenu { return "\(menu.title)(\(menu.children.map(signature).joined(separator: ",")))" }
    return "\(item.title):\((item as? UIAction)?.state == .on)"
  }
}

/// A view that holds focus, so the remote's presses and swipes come to it.
private final class RemoteSurface: UIView {
  override var canBecomeFocused: Bool { true }
}

private final class GradientView: UIView {
  override class var layerClass: AnyClass { CAGradientLayer.self }

  override init(frame: CGRect) {
    super.init(frame: frame)
    let gradient = layer as? CAGradientLayer
    gradient?.colors = [UIColor.clear.cgColor, UIColor.black.withAlphaComponent(0.8).cgColor]
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

/// What played, what is buffered, the rest, and where a scrub stands.
private final class TransportTimeline: UIView {
  private let track = CALayer()
  private let bufferedBar = CALayer()
  private let playedBar = CALayer()
  private let head = CALayer()

  var played: CGFloat = 0 { didSet { setNeedsLayout() } }
  var buffered: CGFloat? { didSet { setNeedsLayout() } }
  var scrubbed: CGFloat? { didSet { setNeedsLayout() } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    track.backgroundColor = UIColor.white.withAlphaComponent(0.25).cgColor
    bufferedBar.backgroundColor = UIColor.white.withAlphaComponent(0.45).cgColor
    playedBar.backgroundColor = UIColor.white.cgColor
    head.backgroundColor = UIColor.white.cgColor
    for bar in [track, bufferedBar, playedBar, head] {
      bar.cornerRadius = 4
      layer.addSublayer(bar)
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let width = bounds.width
    let line = CGRect(x: 0, y: (bounds.height - 8) / 2, width: width, height: 8)
    track.frame = line
    bufferedBar.frame = CGRect(x: 0, y: line.minY, width: width * (buffered ?? 0), height: 8)
    playedBar.frame = CGRect(x: 0, y: line.minY, width: width * played, height: 8)
    head.isHidden = scrubbed == nil
    if let scrubbed {
      head.frame = CGRect(x: width * scrubbed - 3, y: line.minY - 12, width: 6, height: 32)
      head.cornerRadius = 3
    }
    CATransaction.commit()
  }
}

/// The picture of the moment a scrub stands at, and its time.
private final class ScrubCard: UIView {
  private let imageView = UIImageView()
  private let timeLabel = UILabel()
  private static let width: CGFloat = 480
  private static let timeHeight: CGFloat = 48

  var showsPicture = false {
    didSet {
      imageView.isHidden = !showsPicture
      setNeedsLayout()
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    imageView.backgroundColor = UIColor.black.withAlphaComponent(0.6)
    imageView.contentMode = .scaleAspectFit
    imageView.clipsToBounds = true
    imageView.layer.cornerRadius = 12
    imageView.layer.borderColor = UIColor.white.withAlphaComponent(0.35).cgColor
    imageView.layer.borderWidth = 2
    addSubview(imageView)
    timeLabel.font = .monospacedDigitSystemFont(ofSize: 34, weight: .semibold)
    timeLabel.textColor = .white
    timeLabel.textAlignment = .center
    timeLabel.layer.shadowColor = UIColor.black.cgColor
    timeLabel.layer.shadowOpacity = 0.8
    timeLabel.layer.shadowRadius = 4
    timeLabel.layer.shadowOffset = .zero
    addSubview(timeLabel)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func set(image: UIImage?, time: String) {
    if imageView.image !== image { imageView.image = image }
    timeLabel.text = time
  }

  /// The card for a picture of that shape, 16:9 until it is known.
  func size(for picture: CGSize?) -> CGSize {
    guard showsPicture else { return CGSize(width: 240, height: Self.timeHeight) }
    let shape = picture.flatMap { $0.width > 0 && $0.height > 0 ? $0.width / $0.height : nil } ?? 16.0 / 9
    return CGSize(width: Self.width, height: (Self.width / shape).rounded() + Self.timeHeight)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    imageView.frame = CGRect(x: 0, y: 0, width: bounds.width, height: bounds.height - Self.timeHeight)
    timeLabel.frame = CGRect(x: 0, y: bounds.height - Self.timeHeight, width: bounds.width, height: Self.timeHeight)
  }
}
