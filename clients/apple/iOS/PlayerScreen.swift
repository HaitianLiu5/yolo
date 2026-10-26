import AVKit
import MediaPlayer
import SwiftUI
import YoloKit

/// The player, full screen in landscape, with the app's own controls over
/// the picture: close, the picture's size, picture in picture, and the volume along
/// the top; back and forward ten seconds and play or pause in the middle;
/// the title, the timeline (played, buffered, the rest), what plays next,
/// settings, and AirPlay along the bottom. A tap shows or hides them, and they hide
/// themselves while it plays; a double tap on the left or right third skips
/// ten seconds back or forward, and a vertical swipe sets the brightness on
/// the left half and the volume on the right. Text subtitles and danmaku are drawn over the
/// picture, since AVPlayer cannot attach a sidecar WebVTT file to a stream
/// (Agent Note 2026-10-23-iphone-and-ipad-client).
struct PlayerScreen: View {
  @Environment(AppModel.self) private var model
  @Environment(\.scenePhase) private var scenePhase
  @State private var shown = true
  @State private var size = PictureSize.fit
  /// Where the owner drags the timeline, until they let go.
  @State private var scrubbing: Double?
  @State private var surface = PictureSurface()
  /// Restarts the hiding countdown on each touch.
  @State private var touched = 0
  /// The list of what plays next, beside the picture.
  @State private var listing = false
  /// What double-tapping a side of the picture skipped, shown on that side
  /// for a moment; taps in a row add up.
  @State private var skipped: (seconds: Int, at: Date)?
  /// The hidden system volume slider the volume control and swipes set.
  @State private var volume = SystemVolume()
  /// A vertical swipe in progress: brightness on the left half, volume on
  /// the right, with the level it started from.
  @State private var swipe: (kind: SwipeLevel, from: Double)?
  /// What a swipe set, shown at the top while it moves and a moment after.
  @State private var level: (kind: SwipeLevel, value: Double, at: Date)?

  private var player: Player { model.player }
  /// The height of every button and capsule over the picture, as Infuse's.
  static let control: CGFloat = 40

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      PictureView(surface: surface, player: player.player, caption: player.caption, danmaku: model.danmaku,
                  time: { player.position }, fill: size == .fill)
        // Fit keeps clear of the side with the camera but takes the whole
        // height, home indicator's strip included, as Infuse's does.
        .ignoresSafeArea(edges: size == .fit ? .vertical : .all)
      SystemVolumeView(system: volume).frame(width: 1, height: 1).opacity(0.01).allowsHitTesting(false)
      GeometryReader { proxy in
        Color.clear.contentShape(Rectangle())
          .onTapGesture(count: 2) { location in doubleTapped(at: location.x, width: proxy.size.width) }
          .onTapGesture { withAnimation(.easeInOut(duration: 0.2)) { shown.toggle() } }
          .gesture(
            DragGesture(minimumDistance: 12)
              .onChanged { value in swiped(value, in: proxy.size) }
              .onEnded { _ in swipeEnded() }
          )
      }
      .ignoresSafeArea()
      if let level {
        LevelBadge(kind: level.kind, value: level.value)
          .frame(maxHeight: .infinity, alignment: .top)
          .padding(.top, 16)
          .allowsHitTesting(false)
          .transition(.opacity)
      }
      if let skipped {
        SkipOverlay(seconds: skipped.seconds, start: skipped.at)
          .ignoresSafeArea()
          .allowsHitTesting(false)
      }
      // Nothing loaded while the player closes: no empty controls.
      if shown, player.current != nil || model.starting != nil {
        controls.transition(.opacity)
      }
      if listing, player.current != nil {
        Color.black.opacity(0.3).ignoresSafeArea()
          .onTapGesture { withAnimation { listing = false } }
        HStack {
          Spacer()
          UpNextPanel(model: model) { withAnimation { listing = false } }
        }
        .transition(.move(edge: .trailing))
      }
    }
    .statusBarHidden()
    .persistentSystemOverlays(.hidden)
    .task(id: touched) {
      try? await Task.sleep(for: .seconds(4))
      if !Task.isCancelled, player.isPlaying, scrubbing == nil, !listing { withAnimation { shown = false } }
    }
    .onChange(of: shown) { _, now in if now { touched += 1 } }
    // Closed here or by Yolo: browsing, offscreen behind this screen, would
    // not see it end.
    .onChange(of: player.isPresented || model.starting != nil) { _, open in
      if !open { PlayerPresenter.shared.show(false, model: model) }
    }
    // Once it starts playing, the controls hide on their own as after a touch.
    .onChange(of: player.status) { _, status in if status == .playing { touched += 1 } }
    // Back in the app, the picture leaves its window for the player again.
    .onChange(of: scenePhase) { _, phase in if phase == .active { surface.stopPictureInPicture() } }
  }

  private var controls: some View {
    ZStack {
      // Shade top and bottom so white controls read on any picture.
      LinearGradient(colors: [.black.opacity(0.55), .clear, .clear, .black.opacity(0.65)], startPoint: .top, endPoint: .bottom)
        .ignoresSafeArea()
        .allowsHitTesting(false)
      VStack(spacing: 0) {
        HStack(spacing: 10) {
          GlassButton(systemImage: "xmark", label: "Close") { model.leftPlayer() }
          HStack(spacing: 0) {
            GlassIcon(systemImage: size.symbol, label: size.label) {
              withAnimation(.easeInOut(duration: 0.2)) { size = size.next }
              touched += 1
            }
            if surface.pictureInPicturePossible {
              GlassIcon(systemImage: "pip.enter", label: "Picture in Picture") { surface.startPictureInPicture() }
            }
          }
          .glassCapsule()
          Spacer()
          VolumeControl(system: volume)
            .glassCapsule()
        }
        Spacer()
        transport
        Spacer()
        bottom
      }
      .padding(.horizontal, 12)
      .padding(.top, 24)
      .padding(.bottom, 12)
    }
  }

  private var transport: some View {
    HStack(spacing: 56) {
      Button { seek(by: -10) } label: { Image(systemName: "gobackward.10") }
        .accessibilityLabel("Back 10 seconds")
      Button {
        if player.isPlaying { player.player.pause() } else { player.player.play() }
        touched += 1
      } label: {
        // A ring turning around play from the tap until it plays and while
        // it buffers, as Infuse's.
        switch player.current == nil ? .loading : player.status {
        case .loading, .buffering:
          Image(systemName: "play.fill").font(.system(size: 30)).frame(width: 72, height: 64)
            .overlay { LoadingRing() }
        case .playing:
          Image(systemName: "pause.fill").font(.system(size: 54)).frame(width: 72, height: 64)
        default:
          Image(systemName: "play.fill").font(.system(size: 54)).frame(width: 72, height: 64)
        }
      }
      .accessibilityLabel(player.isPlaying ? "Pause" : "Play")
      Button { seek(by: 10) } label: { Image(systemName: "goforward.10") }
        .accessibilityLabel("Forward 10 seconds")
    }
    .font(.system(size: 28))
    .foregroundStyle(.white)
    .buttonStyle(.pressable)
  }

  private var bottom: some View {
    TimelineView(.periodic(from: .now, by: 0.5)) { _ in
      let duration = player.duration ?? 0
      let position = scrubbing ?? player.position
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .bottom) {
          VStack(alignment: .leading, spacing: 2) {
            if let subtitle = player.subtitle {
              Text(subtitle).font(.system(size: 13, weight: .medium)).lineLimit(1)
                .foregroundStyle(.white.opacity(0.85))
            }
            if let title = player.title ?? model.starting {
              Text(title).font(.title3.weight(.semibold)).lineLimit(1)
            }
          }
          .foregroundStyle(.white)
          .shadow(color: .black.opacity(0.4), radius: 4)
          Spacer(minLength: 16)
          HStack(spacing: 0) {
            if model.danmaku.available {
              let enabled = model.danmaku.settings.enabled
              GlassIcon(systemImage: enabled ? "text.bubble.fill" : "text.bubble", label: enabled ? "Hide Danmaku" : "Show Danmaku") {
                model.changeDanmaku(["enabled": .bool(!enabled)])
                touched += 1
              }
            }
            GlassIcon(systemImage: "list.bullet", label: "Up Next") {
              withAnimation { listing = true }
            }
            SettingsMenu(model: model, touched: $touched)
            AirPlayButton().frame(width: PlayerScreen.control + 4, height: PlayerScreen.control)
          }
          .glassCapsule()
        }
        VStack(spacing: 4) {
          Timeline(position: position, buffered: player.bufferedEnd, duration: duration) { value in
            scrubbing = value
            touched += 1
          } onEnd: { value in
            scrubbing = nil
            model.seekHere(to: value)
          }
          HStack {
            Text(Self.clock(position))
            Spacer()
            Text("-" + Self.clock(max(0, duration - position)))
          }
          .font(.caption.monospacedDigit())
          .foregroundStyle(.white.opacity(0.75))
        }
      }
    }
  }

  /// A double tap on the left or right third of the picture skips back or
  /// forward ten seconds; the middle third does nothing.
  private func doubleTapped(at x: CGFloat, width: CGFloat) {
    guard width > 0, player.current != nil else { return }
    let step: Int
    switch x / width {
    case ..<(1.0 / 3): step = -10
    case (2.0 / 3)...: step = 10
    default: return
    }
    seek(by: Double(step))
    let now = Date()
    let total = skipped.map { $0.seconds.signum() == step.signum() && now.timeIntervalSince($0.at) < 1.2 ? $0.seconds + step : step } ?? step
    skipped = (total, now)
    Task {
      try? await Task.sleep(for: .seconds(SkipOverlay.duration))
      if skipped?.at == now { skipped = nil }
    }
  }

  /// A vertical swipe sets the screen's brightness on the left half and the
  /// volume on the right, as Infuse's: the picture's height is the whole
  /// range. A swipe that starts sideways, or at the very top or bottom
  /// where the system's own swipes begin, sets nothing.
  private func swiped(_ value: DragGesture.Value, in size: CGSize) {
    guard player.current != nil, size.height > 0 else { return }
    if swipe == nil {
      let start = value.startLocation
      guard abs(value.translation.height) > abs(value.translation.width),
            start.y > 40, start.y < size.height - 40
      else { return }
      let kind: SwipeLevel = start.x < size.width / 2 ? .brightness : .volume
      swipe = (kind, kind == .brightness ? Double(UIScreen.main.brightness) : Double(AVAudioSession.sharedInstance().outputVolume))
    }
    guard let swipe else { return }
    let value = min(1, max(0, swipe.from - value.translation.height / (size.height * 0.8)))
    switch swipe.kind {
    case .brightness: UIScreen.main.brightness = CGFloat(value)
    case .volume: volume.set(Float(value))
    }
    withAnimation(.easeOut(duration: 0.15)) { level = (swipe.kind, value, Date()) }
  }

  private func swipeEnded() {
    guard swipe != nil else { return }
    swipe = nil
    let at = level?.at
    Task {
      try? await Task.sleep(for: .seconds(0.8))
      if swipe == nil, level?.at == at { withAnimation { level = nil } }
    }
  }

  private func seek(by seconds: Double) {
    let duration = player.duration ?? .infinity
    model.seekHere(to: min(max(0, player.position + seconds), duration))
    touched += 1
  }

  static func clock(_ seconds: Double) -> String {
    let total = Int(seconds.isFinite ? seconds : 0)
    return total >= 3600
      ? String(format: "%d:%02d:%02d", total / 3600, total / 60 % 60, total % 60)
      : String(format: "%d:%02d", total / 60, total % 60)
  }
}

/// The thin line Infuse-style players draw: what played in white, what is
/// buffered lighter, the rest dark; it thickens under the finger.
private struct Timeline: View {
  let position: Double
  let buffered: Double?
  let duration: Double
  let onChange: (Double) -> Void
  let onEnd: (Double) -> Void
  @State private var dragging = false

  var body: some View {
    GeometryReader { proxy in
      let width = proxy.size.width
      let fraction = { (value: Double) in duration > 0 ? CGFloat(min(1, max(0, value / duration))) : 0 }
      ZStack(alignment: .leading) {
        Capsule().fill(.white.opacity(0.25))
        if let buffered {
          Capsule().fill(.white.opacity(0.45)).frame(width: width * fraction(buffered))
        }
        Capsule().fill(.white).frame(width: width * fraction(position))
      }
      .frame(height: dragging ? 10 : 5)
      .frame(maxHeight: .infinity)
      // The finger's target reaches past the line's short frame.
      .contentShape(Rectangle().inset(by: -12))
      .gesture(
        DragGesture(minimumDistance: 0)
          .onChanged { value in
            dragging = true
            onChange(Double(min(1, max(0, value.location.x / width))) * duration)
          }
          .onEnded { value in
            dragging = false
            onEnd(Double(min(1, max(0, value.location.x / width))) * duration)
          }
      )
      .animation(.easeOut(duration: 0.15), value: dragging)
    }
    .frame(height: 12)
    .accessibilityElement()
    .accessibilityLabel("Timeline")
    .accessibilityValue(PlayerScreen.clock(position))
  }
}

/// What plays after this: the item's run from it on, as Yolo's source
/// gives it (a show's episodes, a video's parts); a tap plays one here.
private struct UpNextPanel: View {
  let model: AppModel
  let close: () -> Void
  @State private var title: String?
  @State private var items: [MediaItem] = []
  @State private var loaded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(title ?? "Up Next").font(.headline).lineLimit(1)
        Spacer()
        Button(action: close) { Image(systemName: "xmark").font(.headline) }
          .buttonStyle(.pressable)
          .accessibilityLabel("Close")
      }
      .padding(16)
      if !loaded {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if items.isEmpty {
        Text("Nothing plays after this.")
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ScrollView {
          LazyVStack(spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
              Button {
                if index > 0 {
                  model.play(item)
                  close()
                }
              } label: {
                row(item, playing: index == 0)
              }
              .buttonStyle(.pressable)
            }
          }
          .padding(.horizontal, 8)
          .padding(.bottom, 16)
        }
      }
    }
    .foregroundStyle(.white)
    .frame(width: 380)
    .frame(maxHeight: .infinity)
    .background(.ultraThinMaterial)
    .environment(\.colorScheme, .dark)
    .task(id: model.player.sessionId) {
      (title, items) = await model.upNext()
      loaded = true
    }
  }

  private func row(_ item: MediaItem, playing: Bool) -> some View {
    HStack(spacing: 12) {
      Color.clear
        .frame(width: 128, height: 72)
        .overlay { ArtworkView(thumbnail: item.thumbnail, landscape: true) }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay {
          if playing {
            Image(systemName: "waveform").font(.title3).padding(6).background(.black.opacity(0.5), in: Circle())
          }
        }
      VStack(alignment: .leading, spacing: 4) {
        Text(item.title).font(.subheadline.weight(.medium)).lineLimit(2)
        if playing {
          Text("Now Playing").font(.caption).foregroundStyle(.secondary)
        } else if let duration = item.duration, duration > 0 {
          Text("\(max(1, Int(duration / 60))) min").font(.caption).foregroundStyle(.secondary)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(8)
    .background(playing ? Color.white.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 10))
    .contentShape(Rectangle())
  }
}

/// Speed, quality, audio, and subtitles, as the gear's menu.
private struct SettingsMenu: View {
  let model: AppModel
  @Binding var touched: Int

  private static let speeds: [Float] = [0.5, 0.75, 1, 1.25, 1.5, 2]

  /// The danmaku settings, as the Apple TV's transport bar offers them.
  private var danmaku: some View {
    let settings = model.danmaku.settings
    func choices(_ title: String, _ key: String, _ options: [(String, JSONValue)], current: JSONValue) -> some View {
      Picker(title, selection: Binding(get: { current }, set: { model.changeDanmaku([key: $0]) })) {
        ForEach(options, id: \.0) { label, value in Text(label).tag(value) }
      }
      .pickerStyle(.menu)
    }
    return Menu {
      Toggle("Show Danmaku", isOn: Binding(get: { settings.enabled }, set: { model.changeDanmaku(["enabled": .bool($0)]) }))
      choices("Density", "density", [("Fewer", "low"), ("Normal", "normal"), ("All", "high")], current: .string(settings.density))
      choices("Area", "area", [("Full", "full"), ("Top half", "half"), ("Top quarter", "quarter")], current: .string(settings.area))
      choices("Opacity", "opacity", DanmakuSettings.opacities.map { ("\(Int($0 * 100))%", .number($0)) },
              current: .number(DanmakuSettings.opacities.min { abs($0 - settings.opacity) < abs($1 - settings.opacity) } ?? 0.8))
      choices("Text Size", "fontSize", [("Small", "small"), ("Normal", "normal"), ("Large", "large")], current: .string(settings.fontSize))
    } label: {
      Label("Danmaku", systemImage: settings.enabled ? "text.bubble.fill" : "text.bubble")
    }
  }

  var body: some View {
    let tracks = model.player.tracks
    Menu {
      Menu {
        Picker("Playback Speed", selection: Binding(get: { model.player.player.defaultRate }, set: { rate in
          model.player.player.defaultRate = rate
          if model.player.isPlaying { model.player.player.rate = rate }
        })) {
          ForEach(Self.speeds, id: \.self) { speed in
            Text(speed == 1 ? "Normal" : "\(speed.formatted())×").tag(speed)
          }
        }
      } label: {
        Label("Playback Speed", systemImage: "gauge.with.dots.needle.33percent")
      }
      Menu {
        Picker("Quality", selection: Binding(get: { QualityTag(model.chosenQuality) }, set: { model.chooseQuality($0.cap) })) {
          Text("Auto").tag(QualityTag.auto)
          Text("Highest").tag(QualityTag.capped(nil))
          ForEach(model.qualityChoices.reversed(), id: \.self) { kbps in
            Text(Self.rate(kbps)).tag(QualityTag.capped(kbps))
          }
        }
      } label: {
        Label(QualityTag(model.chosenQuality).name, systemImage: "slider.horizontal.3")
      }
      if model.danmaku.available {
        danmaku
      }
      if tracks.audio.count > 1 {
        Menu {
          Picker("Audio", selection: Binding(get: { tracks.currentAudio ?? "" }, set: { model.chooseAudio($0) })) {
            ForEach(tracks.audio, id: \.id) { track in Text(track.label).tag(track.id) }
          }
        } label: {
          Label(tracks.audio.first { $0.id == tracks.currentAudio }?.label ?? "Audio", systemImage: "music.note")
        }
      }
      if !tracks.subtitles.isEmpty {
        Menu {
          Picker("Subtitles", selection: Binding(get: { tracks.selected.first ?? "" }, set: { id in
            model.chooseSubtitles(id.isEmpty ? [] : [id])
          })) {
            Text("None").tag("")
            ForEach(tracks.subtitles, id: \.id) { track in Text(track.name ?? track.language ?? track.id).tag(track.id) }
          }
        } label: {
          Label(tracks.subtitles.first { $0.id == tracks.selected.first }.map { $0.name ?? $0.language ?? $0.id } ?? "None",
                systemImage: "captions.bubble")
        }
      }
    } label: {
      Image(systemName: "gearshape.fill")
        .font(.system(size: 17))
        .foregroundStyle(.white)
        .frame(width: PlayerScreen.control + 4, height: PlayerScreen.control)
    }
    // Opened from the bottom, a menu would list Auto last.
    .menuOrder(.fixed)
    .accessibilityLabel("Settings")
  }

  static func rate(_ kbps: Int) -> String {
    kbps >= 1000 ? "\((Double(kbps) / 1000).formatted()) Mbps" : "\(kbps) kbps"
  }

  /// The quality picker's choices: Auto, or a cap (nil for the highest).
  enum QualityTag: Hashable {
    case auto
    case capped(Int?)

    init(_ chosen: Int??) {
      if let chosen { self = .capped(chosen) } else { self = .auto }
    }

    var cap: Int?? {
      if case .capped(let cap) = self { return .some(cap) }
      return nil
    }

    var name: String {
      switch self {
      case .auto: "Quality: Auto"
      case .capped(nil): "Quality: Highest"
      case .capped(let kbps?): "Quality: \(SettingsMenu.rate(kbps))"
      }
    }
  }
}

/// A round glass button, as the close button.
private struct GlassButton: View {
  let systemImage: String
  let label: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: systemImage)
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(.white)
        .frame(width: PlayerScreen.control, height: PlayerScreen.control)
    }
    .buttonStyle(.pressable)
    .glassCapsule()
    .accessibilityLabel(label)
  }
}

/// One icon inside a glass capsule of several.
private struct GlassIcon: View {
  let systemImage: String
  let label: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: systemImage)
        .font(.system(size: 17))
        .foregroundStyle(.white)
        .frame(width: PlayerScreen.control + 4, height: PlayerScreen.control)
    }
    .buttonStyle(.pressable)
    .accessibilityLabel(label)
  }
}

/// The press feedback system buttons give: dimmed and a little smaller
/// while the finger is down.
struct PressableButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .contentShape(Rectangle())
      .opacity(configuration.isPressed ? 0.4 : 1)
      .scaleEffect(configuration.isPressed ? 0.92 : 1)
      .animation(.easeOut(duration: configuration.isPressed ? 0.08 : 0.2), value: configuration.isPressed)
  }
}

extension ButtonStyle where Self == PressableButtonStyle {
  static var pressable: PressableButtonStyle { PressableButtonStyle() }
}

extension View {
  /// Liquid glass where the system has it, a material capsule before.
  @ViewBuilder func glassCapsule() -> some View {
    if #available(iOS 26, *) {
      glassEffect(.regular.interactive(), in: Capsule())
    } else {
      background(.ultraThinMaterial, in: Capsule())
    }
  }
}

/// The system's AirPlay picker.
private struct AirPlayButton: UIViewRepresentable {
  func makeUIView(context: Context) -> AVRoutePickerView {
    let view = AVRoutePickerView()
    view.tintColor = .white
    view.activeTintColor = .systemBlue
    view.prioritizesVideoDevices = true
    return view
  }

  func updateUIView(_ view: AVRoutePickerView, context: Context) {}
}

/// The system's volume slider, which follows the hardware buttons.
enum SwipeLevel { case brightness, volume }

/// What a swipe sets, in a capsule at the top as Infuse shows it.
private struct LevelBadge: View {
  let kind: SwipeLevel
  let value: Double

  var body: some View {
    HStack(spacing: 14) {
      Group {
        switch kind {
        case .brightness: Image(systemName: "sun.max")
        case .volume: Image(systemName: value == 0 ? "speaker.slash.fill" : "speaker.wave.3.fill", variableValue: value)
        }
      }
      .font(.system(size: 18, weight: .medium))
      .frame(width: 24)
      Text("\(Int((value * 100).rounded()))%")
        .font(.system(size: 15, weight: .medium).monospacedDigit())
        .frame(width: 44, alignment: .trailing)
    }
    .foregroundStyle(.white)
    .frame(height: PlayerScreen.control)
    .padding(.horizontal, 20)
    .glassCapsule()
  }
}

/// An arc turning around the play button while the stream loads.
private struct LoadingRing: View {
  @State private var turning = false

  var body: some View {
    ZStack {
      Circle().stroke(.white.opacity(0.25), lineWidth: 2.5)
      Circle().trim(from: 0, to: 0.3)
        .stroke(.white, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
        .rotationEffect(.degrees(turning ? 360 : 0))
        .animation(.linear(duration: 0.9).repeatForever(autoreverses: false), value: turning)
    }
    .frame(width: 60, height: 60)
    .onAppear { turning = true }
  }
}

/// The skip a double tap made, as Infuse plays it once per tap: that side of
/// the picture lit by a wide arc and "10 seconds" fading in, then three
/// triangles, each in its fixed place, lighting one by one in the skip's
/// direction and going out the same way, before it all fades out.
private struct SkipOverlay: View {
  static let duration = 1.1
  let seconds: Int
  let start: Date

  private var forward: Bool { seconds > 0 }

  /// A ramp from 0 to 1 between two moments of the animation.
  private static func ramp(_ t: Double, _ from: Double, _ to: Double) -> Double {
    min(1, max(0, (t - from) / (to - from)))
  }

  /// Triangle `index` in the skip's direction: it appears dim and brightens,
  /// one after another, then dims and goes the same way.
  private static func triangle(_ index: Int, at t: Double) -> Double {
    let i = Double(index)
    let rise = ramp(t, 0.06 + 0.13 * i, 0.22 + 0.13 * i)
    let fall = ramp(t, 0.55 + 0.11 * i, 0.71 + 0.11 * i)
    guard rise > 0, fall < 1 else { return 0 }
    return (0.3 + 0.7 * rise) * (1 - 0.7 * fall)
  }

  var body: some View {
    TimelineView(.animation) { context in
      let t = context.date.timeIntervalSince(start) / Self.duration
      let shown = Self.ramp(t, 0, 0.1) * (1 - Self.ramp(t, 0.85, 1))
      GeometryReader { proxy in
        let size = proxy.size
        // A circle taller than the screen, its near edge 40% in from the side.
        let diameter = size.height * 1.6
        let edge = size.width * 0.4
        ZStack {
          Circle()
            .fill(.white.opacity(0.1))
            .frame(width: diameter, height: diameter)
            .position(x: forward ? size.width - edge + diameter / 2 : edge - diameter / 2, y: size.height / 2)
            .opacity(shown)
          VStack(spacing: 10) {
            HStack(spacing: 1) {
              // Each triangle keeps its place; only its opacity changes.
              ForEach(0..<3) { index in
                Image(systemName: "play.fill").opacity(Self.triangle(index, at: t))
              }
            }
            .scaleEffect(x: forward ? 1 : -1)
            .font(.system(size: 17))
            .frame(height: 20)
            Text("\(abs(seconds)) seconds").font(.system(size: 14, weight: .medium)).opacity(shown)
          }
          .foregroundStyle(.white)
          .shadow(color: .black.opacity(0.3), radius: 4)
          .position(x: forward ? size.width - edge * 0.68 : edge * 0.68, y: size.height / 2)
        }
        .frame(width: size.width, height: size.height)
        .clipped()
      }
    }
  }
}

/// The volume as Infuse draws it: the level in percent, a thin line to drag,
/// and the speaker. iOS lets an app set the system volume only through
/// MPVolumeView's slider, so the player keeps a nearly invisible one that
/// takes the value; while it is on screen the system's own volume bezel
/// stays away. The level follows the hardware buttons through the audio
/// session's output volume.
private struct VolumeControl: View {
  let system: SystemVolume
  @State private var level = Double(AVAudioSession.sharedInstance().outputVolume)
  @State private var observation: NSKeyValueObservation?

  var body: some View {
    HStack(spacing: 10) {
      Text("\(Int((level * 100).rounded()))%")
        .font(.system(size: 15, weight: .medium).monospacedDigit())
        .frame(width: 40, alignment: .leading)
      GeometryReader { proxy in
        let width = proxy.size.width
        ZStack(alignment: .leading) {
          Capsule().fill(.white.opacity(0.25)).frame(height: 4)
          Capsule().fill(.white).frame(width: width * level, height: 4)
          Circle().fill(.white).frame(width: 12, height: 12)
            .offset(x: max(0, min(width - 12, width * level - 6)))
        }
        .frame(maxHeight: .infinity)
        .contentShape(Rectangle())
        .gesture(
          DragGesture(minimumDistance: 0).onChanged { value in
            level = min(1, max(0, value.location.x / width))
            system.set(Float(level))
          }
        )
      }
      .frame(width: 100)
      Image(systemName: level == 0 ? "speaker.slash.fill" : "speaker.wave.3.fill", variableValue: level)
        .font(.system(size: 14))
        .frame(width: 24)
    }
    .foregroundStyle(.white)
    .frame(height: PlayerScreen.control)
    .padding(.horizontal, 14)
    .accessibilityElement()
    .accessibilityLabel("Volume")
    .accessibilityValue("\(Int((level * 100).rounded())) percent")
    .accessibilityAdjustableAction { direction in
      level = min(1, max(0, level + (direction == .increment ? 0.0625 : -0.0625)))
      system.set(Float(level))
    }
    .onAppear {
      observation = AVAudioSession.sharedInstance().observe(\.outputVolume) { session, _ in
        let volume = Double(session.outputVolume)
        Task { @MainActor in level = volume }
      }
    }
    .onDisappear { observation = nil }
  }
}

/// The hidden MPVolumeView's slider, the one way to set the system volume;
/// the view adds it only once laid out, so it is found when first needed.
@MainActor
private final class SystemVolume {
  fileprivate weak var view: MPVolumeView?

  func set(_ value: Float) {
    guard let slider = view?.subviews.compactMap({ $0 as? UISlider }).first else { return }
    slider.setValue(value, animated: false)
    slider.sendActions(for: .valueChanged)
  }
}

private struct SystemVolumeView: UIViewRepresentable {
  let system: SystemVolume

  func makeUIView(context: Context) -> MPVolumeView {
    let view = MPVolumeView()
    system.view = view
    return view
  }

  func updateUIView(_ view: MPVolumeView, context: Context) {}
}

/// What the controls ask of the picture: picture in picture, which the
/// system also starts by itself when the owner leaves the app while it
/// plays; and the Now Playing session the lock screen shows.
@MainActor @Observable
final class PictureSurface {
  fileprivate(set) var pictureInPicturePossible = false
  @ObservationIgnored fileprivate var pictureInPicture: AVPictureInPictureController?
  @ObservationIgnored private var possible: NSKeyValueObservation?

  @ObservationIgnored private var nowPlaying: MPNowPlayingSession?
  @ObservationIgnored private let restorer = Restorer()

  fileprivate func attach(_ layer: AVPlayerLayer) {
    if nowPlaying == nil, let player = layer.player {
      // The lock screen and Control Center show what plays and control it.
      let session = MPNowPlayingSession(players: [player])
      session.automaticallyPublishesNowPlayingInfo = true
      session.remoteCommandCenter.playCommand.addTarget { _ in player.play(); return .success }
      session.remoteCommandCenter.pauseCommand.addTarget { _ in player.pause(); return .success }
      session.remoteCommandCenter.togglePlayPauseCommand.addTarget { _ in
        if player.timeControlStatus == .paused { player.play() } else { player.pause() }
        return .success
      }
      session.becomeActiveIfPossible()
      nowPlaying = session
    }
    guard pictureInPicture == nil, AVPictureInPictureController.isPictureInPictureSupported(),
          let controller = AVPictureInPictureController(playerLayer: layer)
    else { return }
    controller.canStartPictureInPictureAutomaticallyFromInline = true
    controller.delegate = restorer
    pictureInPicture = controller
    possible = controller.observe(\.isPictureInPicturePossible, options: [.initial, .new]) { [weak self] controller, _ in
      let value = controller.isPictureInPicturePossible
      Task { @MainActor in self?.pictureInPicturePossible = value }
    }
  }

  func startPictureInPicture() {
    pictureInPicture?.startPictureInPicture()
  }

  func stopPictureInPicture() {
    if pictureInPicture?.isPictureInPictureActive == true { pictureInPicture?.stopPictureInPicture() }
  }

  /// The player screen stays behind the window, so the picture always has
  /// its place to go back to.
  private final class Restorer: NSObject, AVPictureInPictureControllerDelegate {
    func pictureInPictureController(
      _ controller: AVPictureInPictureController,
      restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completion: @escaping (Bool) -> Void
    ) {
      completion(true)
    }
  }
}

/// How big the picture is, as Infuse cycles it: whole between the sides'
/// safe areas,
/// whole across the screen up to its edges, or filling the screen and
/// cropped.
enum PictureSize: CaseIterable {
  case fit, screen, fill

  var next: PictureSize {
    let all = Self.allCases
    return all[(all.firstIndex(of: self)! + 1) % all.count]
  }

  var symbol: String {
    switch self {
    case .fit: "rectangle"
    case .screen: "rectangle.arrowtriangle.2.outward"
    case .fill: "crop"
    }
  }

  var label: String {
    switch self {
    case .fit: "Fit"
    case .screen: "Fit to Screen"
    case .fill: "Fill"
    }
  }
}

/// The picture, with the subtitles and danmaku over it.
private struct PictureView: UIViewRepresentable {
  let surface: PictureSurface
  let player: AVPlayer
  let caption: String?
  let danmaku: Danmaku?
  let time: () -> Double
  let fill: Bool

  func makeUIView(context: Context) -> PlayerLayerView {
    let view = PlayerLayerView()
    view.playerLayer.player = player
    let comments = DanmakuView(frame: view.bounds)
    comments.danmaku = danmaku
    comments.time = time
    comments.baseFontSize = DanmakuGeometry.handheldFontSize
    let label = UILabel()
    label.numberOfLines = 0
    label.textAlignment = .center
    label.textColor = .white
    label.font = .systemFont(ofSize: 24, weight: .semibold)
    label.layer.shadowColor = UIColor.black.cgColor
    label.layer.shadowRadius = 3
    label.layer.shadowOpacity = 0.9
    label.layer.shadowOffset = .zero
    label.translatesAutoresizingMaskIntoConstraints = false
    comments.subtitles = { [weak label] in label?.text?.isEmpty == false }
    comments.picture = { [weak view, weak comments] in
      guard let view, let comments else { return .zero }
      return view.convert(view.playerLayer.videoRect, to: comments)
    }
    view.overlay = comments
    view.addSubview(comments)
    view.addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      label.widthAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.widthAnchor, multiplier: 0.85),
      label.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
    ])
    context.coordinator.label = label
    surface.attach(view.playerLayer)
    return view
  }

  func updateUIView(_ view: PlayerLayerView, context: Context) {
    context.coordinator.label?.text = caption
    let gravity: AVLayerVideoGravity = fill ? .resizeAspectFill : .resizeAspect
    if view.playerLayer.videoGravity != gravity { view.playerLayer.videoGravity = gravity }
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  final class Coordinator {
    var label: UILabel?
  }
}

final class PlayerLayerView: UIView {
  override static var layerClass: AnyClass { AVPlayerLayer.self }
  var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
  /// The danmaku, which spans the whole window even when the picture keeps
  /// to the safe area, so comments enter at the screen's edge.
  var overlay: UIView?

  override func layoutSubviews() {
    super.layoutSubviews()
    if let overlay { overlay.frame = window.map { convert($0.bounds, from: $0) } ?? bounds }
  }
}
