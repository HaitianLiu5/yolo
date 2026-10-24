import AVKit
import SwiftUI
import YoloKit

/// The system's player view, full screen: its controls, scrubbing, and the
/// AirPlay button, with a close button that leaves the player as Back does
/// on the TV. Text subtitles and danmaku are drawn over the picture in its
/// content overlay, since AVPlayer cannot attach a sidecar WebVTT file to a
/// stream (Agent Note 2026-10-23-iphone-and-ipad-client).
struct PlayerScreen: View {
  let player: AVPlayer
  let caption: String?
  var danmaku: Danmaku?
  var time: () -> Double = { 0 }
  var close: () -> Void = {}

  var body: some View {
    ZStack(alignment: .topLeading) {
      Color.black
      SystemPlayer(player: player, caption: caption, danmaku: danmaku, time: time)
      Button(action: close) {
        Image(systemName: "xmark")
          .font(.headline)
          .foregroundStyle(.white)
          .frame(width: 44, height: 44)
          .background(.black.opacity(0.4), in: Circle())
      }
      .accessibilityLabel("Close")
      .padding(.leading, 16)
      .padding(.top, 8)
      .safeAreaPadding(.top)
    }
  }
}

private struct SystemPlayer: UIViewControllerRepresentable {
  let player: AVPlayer
  let caption: String?
  let danmaku: Danmaku?
  let time: () -> Double

  func makeUIViewController(context: Context) -> AVPlayerViewController {
    let controller = AVPlayerViewController()
    controller.player = player
    controller.allowsPictureInPicturePlayback = false
    controller.speeds = AVPlaybackSpeed.systemDefaultSpeeds
    let label = UILabel()
    label.numberOfLines = 0
    label.textAlignment = .center
    label.textColor = .white
    label.font = .preferredFont(forTextStyle: .title3).withSize(22)
    label.layer.shadowColor = UIColor.black.cgColor
    label.layer.shadowRadius = 3
    label.layer.shadowOpacity = 0.9
    label.layer.shadowOffset = .zero
    label.translatesAutoresizingMaskIntoConstraints = false
    if let overlay = controller.contentOverlayView {
      let comments = DanmakuView(frame: overlay.bounds)
      comments.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      comments.danmaku = danmaku
      comments.baseFontSize = DanmakuGeometry.handheldFontSize
      comments.time = time
      comments.subtitles = { [weak label] in label?.text?.isEmpty == false }
      // The picture, aspect-fit in the overlay.
      comments.picture = { [weak player, weak comments] in
        guard let comments else { return .zero }
        let size = player?.currentItem?.presentationSize ?? .zero
        return size.width > 0 ? AVMakeRect(aspectRatio: size, insideRect: comments.bounds) : comments.bounds
      }
      overlay.addSubview(comments)
      overlay.addSubview(label)
      NSLayoutConstraint.activate([
        label.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
        label.widthAnchor.constraint(lessThanOrEqualTo: overlay.widthAnchor, multiplier: 0.9),
        label.bottomAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.bottomAnchor, constant: -48),
      ])
    }
    context.coordinator.label = label
    return controller
  }

  func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
    context.coordinator.label?.text = caption
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  final class Coordinator {
    var label: UILabel?
  }
}
