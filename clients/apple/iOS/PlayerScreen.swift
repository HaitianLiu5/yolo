import AVKit
import MediaPlayer
import SwiftUI
import YoloKit

/// The player, full screen in landscape, with the app's own controls over
/// the picture: close, fill or fit, picture in picture, and the volume along
/// the top; back and forward ten seconds and play or pause in the middle;
/// the title, the timeline (played, buffered, the rest), settings, and
/// AirPlay along the bottom. A tap shows or hides them, and they hide
/// themselves while it plays. Text subtitles and danmaku are drawn over the
/// picture, since AVPlayer cannot attach a sidecar WebVTT file to a stream
/// (Agent Note 2026-10-23-iphone-and-ipad-client).
struct PlayerScreen: View {
  @Environment(AppModel.self) private var model
  @State private var shown = true
  @State private var fill = false
  /// Where the owner drags the timeline, until they let go.
  @State private var scrubbing: Double?
  @State private var surface = PictureSurface()
  /// Restarts the hiding countdown on each touch.
  @State private var touched = 0

  private var player: Player { model.player }

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      PictureView(surface: surface, player: player.player, caption: player.caption, danmaku: model.danmaku,
                  time: { player.position }, fill: fill)
        .ignoresSafeArea()
        .onTapGesture { withAnimation(.easeInOut(duration: 0.2)) { shown.toggle() } }
      // Nothing loaded while the player closes: no empty controls.
      if shown, player.current != nil {
        controls.transition(.opacity)
      }
    }
    .statusBarHidden()
    .persistentSystemOverlays(.hidden)
    .task(id: touched) {
      try? await Task.sleep(for: .seconds(4))
      if !Task.isCancelled, player.isPlaying, scrubbing == nil { withAnimation { shown = false } }
    }
    .onChange(of: shown) { _, now in if now { touched += 1 } }
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
            GlassIcon(systemImage: fill ? "rectangle.arrowtriangle.2.inward" : "rectangle.arrowtriangle.2.outward", label: fill ? "Fit" : "Fill") {
              fill.toggle()
              touched += 1
            }
            if surface.pictureInPicturePossible {
              GlassIcon(systemImage: "pip.enter", label: "Picture in Picture") { surface.startPictureInPicture() }
            }
          }
          .glassCapsule()
          Spacer()
          VolumeSlider()
            .frame(width: 180, height: 44)
            .padding(.horizontal, 14)
            .glassCapsule()
        }
        Spacer()
        transport
        Spacer()
        bottom
      }
      .padding(.horizontal, 20)
      .padding(.vertical, 12)
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
        Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.system(size: 48))
          .frame(width: 64)
      }
      .accessibilityLabel(player.isPlaying ? "Pause" : "Play")
      Button { seek(by: 10) } label: { Image(systemName: "goforward.10") }
        .accessibilityLabel("Forward 10 seconds")
    }
    .font(.system(size: 30, weight: .medium))
    .foregroundStyle(.white)
    .buttonStyle(.plain)
  }

  private var bottom: some View {
    TimelineView(.periodic(from: .now, by: 0.5)) { _ in
      let duration = player.duration ?? 0
      let position = scrubbing ?? player.position
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .bottom) {
          VStack(alignment: .leading, spacing: 4) {
            if let subtitle = player.subtitle {
              Text(subtitle).font(.subheadline.weight(.medium))
            }
            if let title = player.title {
              Text(title).font(.title2.bold()).lineLimit(1)
            }
          }
          .foregroundStyle(.white)
          .shadow(color: .black.opacity(0.4), radius: 4)
          Spacer(minLength: 16)
          HStack(spacing: 0) {
            SettingsMenu(model: model, touched: $touched)
            AirPlayButton().frame(width: 48, height: 44)
          }
          .glassCapsule()
        }
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
      .contentShape(Rectangle())
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
    .frame(height: 24)
    .accessibilityElement()
    .accessibilityLabel("Timeline")
    .accessibilityValue(PlayerScreen.clock(position))
  }
}

/// Speed, audio, and subtitles, as the gear's menu.
private struct SettingsMenu: View {
  let model: AppModel
  @Binding var touched: Int

  private static let speeds: [Float] = [0.5, 0.75, 1, 1.25, 1.5, 2]

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
        .font(.title3)
        .foregroundStyle(.white)
        .frame(width: 48, height: 44)
    }
    .accessibilityLabel("Settings")
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
        .font(.title3.weight(.semibold))
        .foregroundStyle(.white)
        .frame(width: 44, height: 44)
    }
    .buttonStyle(.plain)
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
        .font(.title3)
        .foregroundStyle(.white)
        .frame(width: 48, height: 44)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }
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
private struct VolumeSlider: UIViewRepresentable {
  func makeUIView(context: Context) -> MPVolumeView {
    let view = MPVolumeView()
    view.tintColor = .white
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
    pictureInPicture = controller
    possible = controller.observe(\.isPictureInPicturePossible, options: [.initial, .new]) { [weak self] controller, _ in
      let value = controller.isPictureInPicturePossible
      Task { @MainActor in self?.pictureInPicturePossible = value }
    }
  }

  func startPictureInPicture() {
    pictureInPicture?.startPictureInPicture()
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
    comments.autoresizingMask = [.flexibleWidth, .flexibleHeight]
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
    comments.picture = { [weak view] in view?.playerLayer.videoRect ?? .zero }
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
}
