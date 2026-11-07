import AVKit
import SwiftUI
import YoloKit

/// The player, full screen: the picture in the system's player view, with
/// the app's controls over it (PlayerController). Text subtitles are drawn
/// over the picture in its content overlay, since AVPlayer cannot attach a
/// sidecar WebVTT file to a stream (Agent Note 2026-10-19-apple-tv-client).
struct PlayerScreen: UIViewControllerRepresentable {
  let playback: Player
  let previews: ScrubPreviews
  let caption: String?
  /// The owner chose a moment on the timeline.
  var seek: (Double) -> Void = { _ in }
  /// The owner left with Back.
  var close: () -> Void = {}
  /// The stream's subtitles for the controls' menu, the ones on screen
  /// checked.
  var tracks: StreamTracks = .none
  var chooseSubtitles: ([String]) -> Void = { _ in }
  var chooseAudio: (String) -> Void = { _ in }
  var share: () -> Void = {}
  /// "Move to": the other screens online that play, and the move.
  var moveTargets: [ScreenDevice] = []
  var move: (String) -> Void = { _ in }
  /// Danmaku: drawn over the picture, under the subtitles.
  var danmaku: Danmaku?
  var danmakuSettings = DanmakuSettings()
  var danmakuAvailable = false
  var changeDanmaku: ([String: JSONValue]) -> Void = { _ in }

  func makeUIViewController(context: Context) -> PlayerController {
    let controller = PlayerController(playback: playback, previews: previews, seek: seek, close: close)
    _ = controller.view
    let player = playback.player
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
    if let overlay = controller.video.contentOverlayView {
      let comments = DanmakuView(frame: overlay.bounds)
      comments.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      comments.danmaku = danmaku
      comments.time = { [weak playback] in playback?.position ?? 0 }
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

  func updateUIViewController(_ controller: PlayerController, context: Context) {
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
    // Sends what plays here to another screen with its whole context
    // (Agent Note 2026-10-31-screen-sessions).
    if !moveTargets.isEmpty {
      items.append(UIMenu(title: "Move to", image: UIImage(systemName: "rectangle.portrait.and.arrow.right"), children: moveTargets.map { device in
        UIAction(title: device.name) { _ in move(device.id) }
      }))
    }
    controller.setMenus(items)
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
