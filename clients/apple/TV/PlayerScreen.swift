import AVKit
import SwiftUI
import YoloKit

/// The system's player view, full screen: the transport bar, scrubbing with
/// the Siri Remote, and Back. Text subtitles are drawn over the picture in
/// its content overlay, since AVPlayer cannot attach a sidecar WebVTT file to
/// a stream (Agent Note 2026-10-19-apple-tv-client).
struct PlayerScreen: UIViewControllerRepresentable {
  let player: AVPlayer
  let caption: String?
  /// The stream's subtitles for the transport bar's menu, the ones on screen
  /// checked.
  var tracks: StreamTracks = .none
  var chooseSubtitles: ([String]) -> Void = { _ in }
  var chooseAudio: (String) -> Void = { _ in }
  var share: () -> Void = {}
  /// Danmaku: drawn over the picture, under the subtitles.
  var danmaku: Danmaku?
  var danmakuSettings = DanmakuSettings()
  var danmakuAvailable = false
  var changeDanmaku: ([String: JSONValue]) -> Void = { _ in }
  var time: () -> Double = { 0 }

  func makeUIViewController(context: Context) -> AVPlayerViewController {
    let controller = AVPlayerViewController()
    controller.player = player
    // The system's speed menu, 0.5x to 2x; the speed lasts while the app
    // runs, as the player's lasts for the page.
    controller.speeds = AVPlaybackSpeed.systemDefaultSpeeds
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
    if let overlay = controller.contentOverlayView {
      let comments = DanmakuView(frame: overlay.bounds)
      comments.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      comments.danmaku = danmaku
      comments.time = time
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

  func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
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
    controller.transportBarCustomMenuItems = items
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
